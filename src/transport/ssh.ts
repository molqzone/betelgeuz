/**
 * The production `SshTransport` implementation, backed by the `ssh2` library.
 *
 * This is the single production transport. It verifies the pinned host key
 * before any channel opens and keeps one SSH session per transport object with
 * independent exec and SFTP channels. Proxy chains are a typed profile feature
 * and land later; until then they fail with `profile.unsupported-proxy` rather
 * than being silently ignored.
 */
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";

import { BetelgeuzError } from "../errors";
import type { ErrorCode } from "../errors";
import {
  ExecHandle,
  ExecRequest,
  HostKeyFingerprint,
  type RemoteFileInfo,
  type SessionLoss,
  type SshConnectOptions,
  type SshEndpoint,
  type SshTransport,
} from "./index";

export class SshClient implements SshTransport {
  private client?: Client;
  private sftp?: SFTPWrapper;
  private connected = false;
  private intentionalClose = false;
  private lossListeners = new Set<(loss: SessionLoss) => void>();

  async inspectHostKey(endpoint: SshEndpoint): Promise<HostKeyFingerprint> {
    let observed: HostKeyFingerprint | undefined;
    const client = new Client();
    // The probe never accepts the session; the fingerprint is recorded before
    // the handshake is rejected.
    await new Promise<void>((resolve, reject) => {
      client
        .on("error", (error) => reject(error))
        .connect({
          host: endpoint.host,
          port: endpoint.port,
          username: endpoint.username,
          hostVerifier: (key: Buffer) => {
            observed = fingerprintOf(key);
            return false;
          },
        });
    }).catch(() => undefined);
    if (observed === undefined) {
      throw new BetelgeuzError("ssh.handshake-failed", {
        detail: "the server did not present a pinnable host key",
      });
    }
    return observed;
  }

  async connect(options: SshConnectOptions): Promise<void> {
    if (options.proxyChain.length > 0) {
      throw new BetelgeuzError("profile.unsupported-proxy", {
        detail: "proxy chains are not yet implemented in the ssh2 transport",
      });
    }
    const pin = options.hostKeyPin;
    let mismatch = false;
    const client = new Client();
    client.on("close", () => this.reportLossIfUnintentional(undefined));
    client.on("error", (error) => this.reportLossIfUnintentional(error));

    const auth =
      options.authentication.kind === "password"
        ? { password: options.authentication.password.expose() }
        : {
            privateKey: Buffer.from(options.authentication.privateKey.expose()),
            passphrase: options.authentication.passphrase?.expose(),
          };

    await new Promise<void>((resolve, reject) => {
      client
        .on("ready", resolve)
        .on("error", reject)
        .connect({
          host: options.endpoint.host,
          port: options.endpoint.port,
          username: options.endpoint.username,
          keepaliveInterval: options.keepaliveSeconds * 1000,
          hostVerifier: (key: Buffer) => {
            const matches = fingerprintOf(key).asString() === pin.asString();
            mismatch = mismatch || !matches;
            return matches;
          },
          ...auth,
        });
    }).catch((error: unknown) => {
      if (mismatch) {
        throw new BetelgeuzError("ssh.hostkey-mismatch", {
          detail: `expected pin ${pin.asString()}`,
          cause: error,
        });
      }
      throw new BetelgeuzError(codeFor(error), { cause: error });
    });

    this.client = client;
    this.connected = true;
    this.intentionalClose = false;
  }

  onSessionLoss(listener: (loss: SessionLoss) => void): () => void {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  async exec(request: ExecRequest): Promise<ExecHandle> {
    const client = this.requireClient();
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec(
        request.command,
        { pty: request.allocatePty },
        (error, stream) => (error ? reject(error) : resolve(stream))
      );
    });
    const handle = new ExecHandle(() => {
      // Polite signal only; escalation is the strategy's job via its
      // recorded process-group handle.
      channel.signal("TERM");
    });
    channel.on("data", (chunk: Buffer) => {
      handle.push({ kind: "output", stream: "stdout", bytes: chunk });
    });
    channel.stderr.on("data", (chunk: Buffer) => {
      handle.push({ kind: "output", stream: "stderr", bytes: chunk });
    });
    channel.on("exit", (status: number | null, signal: string | null) => {
      handle.push({
        kind: "exit",
        status: status ?? undefined,
        signal: signal ?? undefined,
      });
    });
    channel.on("close", () => handle.push(null));
    channel.on("error", () => handle.push(null));
    return handle;
  }

  async upload(source: Readable, remotePath: string): Promise<void> {
    const sftp = await this.sftpSession();
    const writer = sftp.createWriteStream(remotePath);
    try {
      await pipeline(source, writer);
    } catch (error) {
      throw new BetelgeuzError("deploy.upload-failed", { cause: error });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = await this.sftpSession();
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (error: Error | null | undefined) =>
        error
          ? reject(new BetelgeuzError("deploy.commit-failed", { cause: error }))
          : resolve()
      );
    });
  }

  async remove(path: string): Promise<void> {
    const sftp = await this.sftpSession();
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (error: Error | null | undefined) =>
        error
          ? reject(new BetelgeuzError("deploy.commit-failed", { cause: error }))
          : resolve()
      );
    });
  }

  async metadata(path: string): Promise<RemoteFileInfo | null> {
    const sftp = await this.sftpSession();
    return new Promise<RemoteFileInfo | null>((resolve, reject) => {
      sftp.stat(path, (error: Error | null | undefined, stats) => {
        if (error) {
          const code = String((error as NodeJS.ErrnoException).code ?? "");
          if (code === "ENOENT" || code === "2") {
            resolve(null);
            return;
          }
          reject(new BetelgeuzError("ssh.lost", { cause: error }));
          return;
        }
        resolve({ size: stats.size, mode: stats.mode, isFile: stats.isFile() });
      });
    });
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.sftp = undefined;
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    client?.end();
  }

  private requireClient(): Client {
    if (this.client === undefined || !this.connected) {
      throw new BetelgeuzError("ssh.lost");
    }
    return this.client;
  }

  private async sftpSession(): Promise<SFTPWrapper> {
    const client = this.requireClient();
    if (this.sftp === undefined) {
      this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error: Error | undefined, sftp) =>
          error ? reject(new BetelgeuzError("ssh.lost", { cause: error })) : resolve(sftp)
        );
      });
    }
    return this.sftp;
  }

  private reportLossIfUnintentional(error: unknown): void {
    this.connected = false;
    if (this.intentionalClose) {
      return;
    }
    const loss: SessionLoss = {
      cause: "ssh.lost",
      detail: error instanceof Error ? error.message : "connection closed",
    };
    for (const listener of this.lossListeners) {
      listener(loss);
    }
  }
}

/** OpenSSH-style SHA256 fingerprint of a marshaled server key. */
function fingerprintOf(key: Buffer): HostKeyFingerprint {
  const digest = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  return HostKeyFingerprint.parse(`SHA256:${digest}`);
}

/** Maps library failure metadata to a catalog code at the transport boundary
 * (`err.level` is ssh2's structured error category) — never message text. */
function codeFor(error: unknown): ErrorCode {
  const level = (error as { level?: string } | undefined)?.level;
  switch (level) {
    case "client-authentication":
      return "ssh.auth-failed";
    case "client-timeout":
    case "client-socket":
    case "client-dns":
      return "ssh.unreachable";
    default:
      return "ssh.handshake-failed";
  }
}
