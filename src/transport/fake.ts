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

/** One simulated remoteproc instance: the sysfs attributes the control
 *  templates read and write, plus whether this account may write them. */
type FakeRemoteprocInstance = {
  directory: string;
  firmware: string;
  name: string;
  state: string;
  writable: boolean;
};

export class FakeSshTransport implements SshTransport {
  private hostKey = HostKeyFingerprint.parse(DEFAULT_HOST_KEY);
  private connectFailure = false;
  private connected = false;
  private commandEvents = new Map<string, Array<ExecEvent>>();
  private files = new Map<string, Buffer>();
  private lossListeners = new Set<(loss: SessionLoss) => void>();
  private descriptor: HardwareDescriptor = {};
  /** The process identities the fake target reports as live; signalling a
   *  process group ends them unless a test says otherwise. */
  private readonly processes = new Set<number>();
  private killable = true;
  /** The simulated Linux remoteproc instances (empty: no small-core
   *  interface, which is itself a supported target state). */
  private remoteprocInstances: Array<FakeRemoteprocInstance> = [];
  /** Whether the fake account holds a passwordless sudo whitelist entry. */
  private passwordlessSudo = false;

  setHostKey(hostKey: HostKeyFingerprint): void {
    this.hostKey = hostKey;
  }

  /** Marks a pid as running on the fake target so reconciliation can find it. */
  setProcessAlive(pid: number): void {
    this.processes.add(pid);
  }

  /** Makes signalling a no-op, for processes that outlive SIGKILL. */
  setProcessUnkillable(): void {
    this.killable = false;
  }

  /** The simulated remoteproc instances. Index `i` gets directory
   *  `/sys/class/remoteproc/remoteproc${i}`; absent fields default to an
   *  offline, firmware-less, directly writable instance. */
  setRemoteprocInstances(
    instances: ReadonlyArray<{
      name: string;
      state?: string;
      firmware?: string;
      writable?: boolean;
    }>
  ): void {
    this.remoteprocInstances = instances.map((instance, index) => ({
      directory: `/sys/class/remoteproc/remoteproc${index}`,
      firmware: instance.firmware ?? "",
      name: instance.name,
      state: instance.state ?? "offline",
      writable: instance.writable ?? true,
    }));
  }

  /** The passwordless sudo whitelist entry the privilege fallback probes for. */
  setPasswordlessSudo(available: boolean): void {
    this.passwordlessSudo = available;
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

  /** Every remote path the fake target holds, so a test can assert that no
   *  staging file survived an operation. */
  remoteFiles(): Array<string> {
    return [...this.files.keys()];
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
    if (events === undefined && request.command.startsWith("if kill -0 ")) {
      const pid = Number(request.command.match(/^if kill -0 ([0-9]+)/)?.[1]);
      handle.push({
        kind: "output",
        stream: "stdout",
        bytes: Buffer.from(this.processes.has(pid) ? "alive" : "gone"),
      });
      handle.push({ kind: "exit", status: 0 });
      handle.push(null);
      return handle;
    }
    if (events === undefined && request.command.startsWith("kill -s ")) {
      const pid = Number(request.command.match(/-- -([0-9]+)$/)?.[1]);
      if (this.killable) {
        this.processes.delete(pid);
      }
      handle.push({ kind: "exit", status: 0 });
      handle.push(null);
      return handle;
    }
    if (events === undefined && request.command.startsWith("sudo -n -l ")) {
      // The privilege probe asks whether the account may run the whitelisted
      // control write; the answer is the simulated whitelist state.
      handle.push({ kind: "exit", status: this.passwordlessSudo ? 0 : 1 });
      handle.push(null);
      return handle;
    }
    const remoteprocWrite = events === undefined ? this.remoteprocControl(request.command) : undefined;
    if (remoteprocWrite !== undefined) {
      for (const event of remoteprocWrite) {
        handle.push(event);
      }
      handle.push(null);
      return handle;
    }
    if (events === undefined && request.command.includes("trace0")) {
      // The kernel trace is debugfs content; a test that wants output
      // registers it against the exact command string.
      handle.push({ kind: "exit", status: 0 });
      handle.push(null);
      return handle;
    }
    if (
      events === undefined &&
      request.command.startsWith("for d in /sys/class/remoteproc/remoteproc*") &&
      request.command.includes("test -w")
    ) {
      const table = this.remoteprocInstances
        .map((instance) =>
          [
            instance.directory,
            instance.name,
            instance.state,
            instance.firmware,
            instance.writable ? "yes" : "no",
          ].join("\t")
        )
        .map((line) => `${line}\n`)
        .join("");
      handle.push({ kind: "output", stream: "stdout", bytes: Buffer.from(table) });
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

  /**
   * Simulates a remoteproc control write (state or firmware) with the outcome
   * protocol the real template renders: the echoed value on success,
   * `instance-missing` when the fixed loop matches no instance, and a
   * non-zero exit when the write is refused — a directly unwritable control
   * without the sudo whitelist, or a whitelisted write the account lacks.
   * Returns `undefined` when the command is not a control write.
   */
  private remoteprocControl(command: string): Array<ExecEvent> | undefined {
    const attribute = command.includes(`tee "$d/state"`)
      ? "state"
      : command.includes(`tee "$d/firmware"`)
        ? "firmware"
        : undefined;
    if (attribute === undefined) {
      return undefined;
    }
    const name = /test "\$\(cat "\$d\/name" 2>\/dev\/null\)" = '([^']*)'/.exec(command)?.[1];
    const value = /printf '%s\\n' '([^']*)' \|/.exec(command)?.[1];
    if (name === undefined || value === undefined) {
      return undefined;
    }
    const privileged = command.includes("sudo -n ");
    const instance = this.remoteprocInstances.find((entry) => entry.name === name);
    if (instance === undefined) {
      return [
        { kind: "output", stream: "stdout", bytes: Buffer.from("instance-missing\n") },
        { kind: "exit", status: 0 },
      ];
    }
    if (!instance.writable && !(privileged && this.passwordlessSudo)) {
      return [{ kind: "exit", status: 1 }];
    }
    if (attribute === "state") {
      // The kernel's semantics, not a literal echo: writing `start` moves the
      // core to running and `stop` to offline.
      instance.state = value === "start" ? "running" : "offline";
    } else {
      instance.firmware = value;
    }
    return [
      { kind: "output", stream: "stdout", bytes: Buffer.from(`${value}\n`) },
      { kind: "exit", status: 0 },
    ];
  }

  private modes = new Map<string, number>();
}
