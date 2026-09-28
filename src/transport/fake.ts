/**
 * In-memory SSH transport for core and strategy tests.
 *
 * Stream semantics mirror the real channel: the stream stays open while the
 * remote command "runs" and ends after the exit event. A consumer that wants
 * the terminating-signal report must call `terminate`; TypeScript has no drop
 * notification, so an abandoned handle simply stays open (test isolation
 * covers the leak).
 */
import type { Readable } from "node:stream";

import { BetelgeuzError, type ErrorCode } from "../errors";
import {
  ExecEvent,
  ExecHandle,
  ExecRequest,
  HostKeyFingerprint,
  type RemoteFileInfo,
  type SessionLoss,
  type SshConnectOptions,
  type SshEndpoint,
  type SshTransport,
} from "./index";

const DEFAULT_HOST_KEY = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class FakeSshTransport implements SshTransport {
  private hostKey = HostKeyFingerprint.parse(DEFAULT_HOST_KEY);
  private connectFailure = false;
  private connected = false;
  private commandEvents = new Map<string, Array<ExecEvent>>();
  private files = new Map<string, Buffer>();
  private lossListeners = new Set<(loss: SessionLoss) => void>();

  setHostKey(hostKey: HostKeyFingerprint): void {
    this.hostKey = hostKey;
  }

  setConnectFailure(fail: boolean): void {
    this.connectFailure = fail;
  }

  setExecEvents(command: string, events: Array<ExecEvent>): void {
    this.commandEvents.set(command, events);
  }

  remoteFile(path: string): Buffer | undefined {
    return this.files.get(path);
  }

  /** Simulates an established session dropping so consumers can exercise
   * their own reconnect policy. */
  dropConnection(cause: ErrorCode, detail: string): void {
    this.connected = false;
    const loss: SessionLoss = { cause, detail };
    for (const listener of this.lossListeners) {
      listener(loss);
    }
  }

  async inspectHostKey(_endpoint: SshEndpoint): Promise<HostKeyFingerprint> {
    return this.hostKey;
  }

  async connect(options: SshConnectOptions): Promise<void> {
    if (this.connectFailure) {
      throw new BetelgeuzError("ssh.unreachable");
    }
    if (options.hostKeyPin.asString() !== this.hostKey.asString()) {
      throw new BetelgeuzError("ssh.hostkey-mismatch");
    }
    this.connected = true;
  }

  onSessionLoss(listener: (loss: SessionLoss) => void): () => void {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  async exec(request: ExecRequest): Promise<ExecHandle> {
    this.ensureConnected();
    const handle = new ExecHandle(() => {
      handle.push({ kind: "exit", signal: "TERM" });
      handle.push(null);
    });
    for (const event of this.commandEvents.get(request.command) ?? []) {
      handle.push(event);
    }
    return handle;
  }

  async upload(source: Readable, remotePath: string): Promise<void> {
    this.ensureConnected();
    const chunks: Array<Buffer> = [];
    try {
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk as string | Buffer));
      }
    } catch (error) {
      throw new BetelgeuzError("deploy.upload-failed", { cause: error });
    }
    this.files.set(remotePath, Buffer.concat(chunks));
  }

  async rename(from: string, to: string): Promise<void> {
    this.ensureConnected();
    const contents = this.files.get(from);
    if (contents === undefined) {
      throw new BetelgeuzError("deploy.commit-failed", {
        detail: `remote source \`${from}\` does not exist`,
      });
    }
    this.files.delete(from);
    this.files.set(to, contents);
  }

  async remove(path: string): Promise<void> {
    this.ensureConnected();
    this.files.delete(path);
  }

  async metadata(path: string): Promise<RemoteFileInfo | null> {
    this.ensureConnected();
    const contents = this.files.get(path);
    if (contents === undefined) {
      return null;
    }
    return { size: contents.length, mode: 0o644, isFile: true };
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new BetelgeuzError("ssh.lost");
    }
  }
}
