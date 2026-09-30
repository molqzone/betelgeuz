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
import { throwIfAborted } from "../cancellation";
import type { HardwareDescriptor } from "../protocol/descriptor";
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
  private descriptor: HardwareDescriptor = {};

  setHostKey(hostKey: HostKeyFingerprint): void {
    this.hostKey = hostKey;
  }

  setConnectFailure(fail: boolean): void {
    this.connectFailure = fail;
  }

  setExecEvents(command: string, events: Array<ExecEvent>): void {
    this.commandEvents.set(command, events);
  }

  setDescriptor(descriptor: HardwareDescriptor): void {
    this.descriptor = descriptor;
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

  async inspectHostKey(
    _endpoint: SshEndpoint,
    signal?: AbortSignal
  ): Promise<HostKeyFingerprint> {
    throwIfAborted(signal, "identity");
    return this.hostKey;
  }

  async connect(options: SshConnectOptions, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "connect");
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
    }, () => {
      handle.push({ kind: "exit", signal: "KILL" });
      handle.push(null);
    });
    const events = this.commandEvents.get(request.command);
    if (events === undefined && request.command.startsWith("mkdir -p -- ")) {
      handle.push({ kind: "exit", status: 0 });
      handle.push(null);
      return handle;
    }
    if (
      events === undefined &&
      request.command.startsWith("if test -r /etc/betelgeuz/device.json")
    ) {
      handle.push({
        kind: "output",
        stream: "stdout",
        bytes: Buffer.from(JSON.stringify(this.descriptor)),
      });
      handle.push({ kind: "exit", status: 0 });
      handle.push(null);
      return handle;
    }
    if (events === undefined && request.command.startsWith("printf 'machine\\t'")) {
      handle.push({
        kind: "output",
        stream: "stdout",
        bytes: Buffer.from(
          "machine\taarch64\nelfClass\t64\nendianness\tlittle\ninterpreter\t/lib/ld-musl-aarch64.so.1\n"
        ),
      });
      handle.push({ kind: "exit", status: 0 });
      handle.push(null);
      return handle;
    }
    if (events === undefined && request.command.startsWith("printf 'writable\\t'")) {
      handle.push({
        kind: "output",
        stream: "stdout",
        bytes: Buffer.from("writable\tyes\nfreeBytes\t104857600\nnoexec\tno\n"),
      });
      handle.push({ kind: "exit", status: 0 });
      handle.push(null);
      return handle;
    }
    if (events !== undefined) {
      for (const event of events) {
        handle.push(event);
      }
      handle.push(null);
    }
    if (request.command.startsWith("if test -r /etc/betelgeuz/device.json")) {
      handle.push(null);
    }
    return handle;
  }

  async upload(source: Readable, remotePath: string, signal?: AbortSignal): Promise<void> {
    this.ensureConnected();
    const chunks: Array<Buffer> = [];
    try {
      for await (const chunk of source) {
        throwIfAborted(signal, "deploy");
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
    const mode = this.modes.get(from);
    this.modes.delete(from);
    if (mode !== undefined) {
      this.modes.set(to, mode);
    }
  }

  async remove(path: string): Promise<void> {
    this.ensureConnected();
    this.files.delete(path);
    this.modes.delete(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.ensureConnected();
    const contents = this.files.get(path);
    if (contents === undefined) {
      throw new BetelgeuzError("deploy.commit-failed", {
        detail: `remote file \`${path}\` does not exist`,
      });
    }
    // The fake stores file bytes separately from metadata; retain mode for
    // the next metadata query without changing the upload representation.
    this.modes.set(path, mode);
  }

  async metadata(path: string): Promise<RemoteFileInfo | null> {
    this.ensureConnected();
    const contents = this.files.get(path);
    if (contents === undefined) {
      return null;
    }
    return { size: contents.length, mode: this.modes.get(path) ?? 0o644, isFile: true };
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new BetelgeuzError("ssh.lost");
    }
  }

  private modes = new Map<string, number>();
}
