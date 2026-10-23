/**
 * Linux userspace application strategy.
 *
 * This module owns the Phase 1 application workflow behind the shared
 * strategy contract (src/strategy.ts): a host artifact is staged through SFTP
 * and atomically renamed, then a structured foreground exec is kept in a
 * small host-side output ring. It deliberately accepts no free-form shell
 * command. The busy lock, the fixed-command runner, and the probe parser come
 * from the shared operation coordinator they now share with the small-core
 * strategy.
 */
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { throwIfAborted } from "../cancellation";
import {
  assertRuntimeCompatible,
  inspectElf,
  normalizeMachine,
  type ElfClass,
  type ElfEndian,
} from "../artifact/elf";
import { verifyArtifactFile } from "../artifact/record";
import { BetelgeuzError, type ErrorCode } from "../errors";
import { MutationLock, isCancellation, parseFields, runFixedCommand } from "../operation";
import type {
  ApplicationConfiguration,
  ArtifactRecord,
  LogsResult,
  OutputChunk,
  OutputListener,
  RunOutcome,
  StatusResult,
} from "../protocol";
import {
  type DeployOptions,
  type DeployOutcome,
  type DeployStrategy,
  type StrategyRun,
} from "../strategy";
import { Secret } from "../secret";
import {
  ExecRequest,
  LAUNCH_PID_MARKER,
  parseLaunchPidLine,
  type ExecHandle,
  type OutputStream,
  type SshTransport,
} from "../transport";

export type { OutputListener, RunOutcome } from "../protocol";

const DEFAULT_RING_BYTES = 256 * 1024;
const DEFAULT_STOP_GRACE_MS = 5_000;
/** Bound on the launcher's pid marker line before it is treated as ordinary
 *  output (E2: the head buffer cannot grow without limit). */
const MAX_MARKER_LINE_BYTES = 64;
/** Poll interval while waiting for a signalled orphan to disappear. */
const ORPHAN_POLL_MS = 250;
/** Confirmation window after SIGKILL: the signal cannot be ignored except by
 *  an uninterruptible process, so one bounded sweep proves the exit. */
const KILL_CONFIRM_MS = ORPHAN_POLL_MS * 2;

/** The application strategy's settings, under their contract name. */
export type SshApplicationConfiguration = ApplicationConfiguration;

export type ApplicationRun = StrategyRun;

export type ApplicationStatus = StatusResult;

export type DeploymentResult = DeployOutcome;

type ActiveRun = {
  readonly completion: Promise<RunOutcome>;
  /** Settles the completion as an outcome no one observed; used when the run
   *  is discarded with its fate still unknown. */
  readonly fail: (error: unknown) => void;
  readonly handle: ExecHandle;
  readonly runId: string;
  /** Recorded from the launcher's pid marker; without it a lost run cannot be
   *  reconciled and cleanup cannot be proven. */
  pid?: number;
  /** Resolves the completion; kept so reconciliation can settle a run whose
   *  channel died before an exit status was observed. */
  readonly settle: (outcome: RunOutcome) => void;
};

type RuntimeProbe = {
  elfClass?: ElfClass;
  endian?: ElfEndian;
  interpreter?: string;
  machine?: string;
};

type DestinationPreflight = {
  freeBytes?: number;
  noexec?: boolean;
  writable?: boolean;
};

/** Strategy implementation shared by the core service and fake transport. */
export class SshApplicationStrategy implements DeployStrategy {
  readonly id = "linux.ssh-app";
  readonly role = "big-core";
  private active?: ActiveRun;
  /** A run whose channel ended without an exit status: the process may be dead
   *  or alive, and only a target probe can say which. Held until `inspect`
   *  reconciles it or `stop` cleans it up. */
  private orphan?: ActiveRun;
  /** Held while a mutating operation runs; a release only clears the token it was
   *  issued with, so an operation that outlived its attach could not clear a newer one. */
  private readonly mutation = new MutationLock();
  private lastOutcome?: RunOutcome;
  private nextCursor = 0;
  private ringTotalBytes = 0;
  private readonly ring: Array<{ cursor: number; chunk: OutputChunk }> = [];

  constructor(private readonly transport: SshTransport) {}

  async deploy(
    artifact: ArtifactRecord,
    configuration: unknown,
    options: DeployOptions = {}
  ): Promise<DeployOutcome> {
    const signal = options.signal;
    // The application strategy refuses to deploy while a run is active rather
    // than stopping it, so `stopRunningTarget` is not consulted here.
    const settings = parseApplicationConfiguration(configuration);
    throwIfAborted(signal, "deploy");
    await this.reconcileOrphan(signal);
    if (this.active !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "cannot deploy while the application is running",
      });
    }
    const releaseMutation = this.mutation.enter();
    try {
    const remotePath = validAbsolutePath(settings.remotePath, "remotePath");
    const mode = parseMode(settings.fileMode);
    const source = await verifyArtifactFile(artifact);
    const elf = await inspectElf(source.path, source.size);
    const runtime = await this.readRuntimeProbe(signal);
    assertRuntimeCompatible(elf, runtime);
    const destination = dirname(remotePath);
    await this.ensureDirectory(destination, signal);
    const preflight = await this.preflight(destination, signal);
    if (preflight.writable !== true || preflight.noexec === true || preflight.noexec === undefined ||
        (preflight.freeBytes !== undefined && preflight.freeBytes < source.size)) {
      throw new BetelgeuzError("deploy.preflight-failed", {
        detail: describePreflightFailure(preflight, source.size),
      });
    }
    const previous = await this.transport.metadata(remotePath);
    const stagingPath = `${remotePath}.betelgeuz-${randomUUID()}.tmp`;
    let committed = false;
    try {
      throwIfAborted(signal, "deploy");
      await this.transport.upload(createReadStream(source.path), stagingPath, signal);
      throwIfAborted(signal, "deploy");
      await this.transport.chmod(stagingPath, mode);
      throwIfAborted(signal, "deploy");
      await this.transport.rename(stagingPath, remotePath);
      committed = true;
      await this.transport.chmod(remotePath, mode);
      return {
        ...(previous === null ? {} : { previousSize: previous.size }),
        remotePath,
      };
    } catch (error) {
      if (!committed) {
        await this.removeStaging(stagingPath);
      }
      if (isCancellation(error) || signal?.aborted === true) {
        throw new BetelgeuzError("deploy.cancelled", {
          phase: "deploy",
          cause: error,
        });
      }
      throw error;
    }
    } finally {
      releaseMutation();
    }
  }

  async start(
    configuration: unknown,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<StrategyRun> {
    const settings = parseApplicationConfiguration(configuration);
    throwIfAborted(signal, "lifecycle");
    await this.reconcileOrphan(signal);
    if (this.active !== undefined || this.mutation.held) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "an application run is already active",
      });
    }
    const releaseMutation = this.mutation.enter();
    try {
    const request = this.launchRequest(settings);
    const handle = await this.transport.exec(request);
    try {
      throwIfAborted(signal, "lifecycle");
    } catch (error) {
      await handle.terminate().catch(() => undefined);
      throw error;
    }
    const runId = `run-${randomUUID()}`;
    let resolveCompletion!: (outcome: RunOutcome) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<RunOutcome>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.active = {
      completion,
      fail: rejectCompletion,
      handle,
      runId,
      settle: resolveCompletion,
    };
    const run = this.active;
    void this.consume(run, resolveCompletion, rejectCompletion, onOutput).catch(
      (error: unknown) => rejectCompletion(error)
    );
    releaseMutation();
    return { completion, runId };
    } catch (error) {
      releaseMutation();
      throw error;
    }
  }

  /** The foreground run's stop needs no configuration; the parameter exists
   *  so every strategy operation has the same shape. */
  async stop(configuration: unknown, graceMs = DEFAULT_STOP_GRACE_MS): Promise<RunOutcome | undefined> {
    void configuration;
    const orphan = this.orphan;
    const active = this.active;
    if (active === undefined && orphan === undefined) {
      if (this.mutation.held) {
        throw new BetelgeuzError("deploy.busy", {
          detail: "another mutating operation is already running",
        });
      }
      return this.lastOutcome;
    }
    const releaseMutation = this.mutation.enter();
    try {
      if (orphan !== undefined) {
        return await this.stopOrphan(orphan, graceMs);
      }
      const run = active as ActiveRun;
      await run.handle.terminate();
      const finished = await raceCompletion(run.completion, graceMs);
      if (finished.kind === "value") {
        return finished.value;
      }
      await run.handle.kill();
      return await run.completion;
    } finally {
      releaseMutation();
    }
  }

  /**
   * Stop for a run whose channel is already gone. The channel can no longer
   * signal anything, so the recorded process group is signalled directly and
   * the probe — not the signal call — proves whether the process ended. If
   * nothing can be proven, `runtime.orphan-risk` says so instead of claiming a
   * stop that may not have happened (plan §4).
   */
  private async stopOrphan(
    orphan: ActiveRun,
    graceMs: number
  ): Promise<RunOutcome> {
    const pid = orphan.pid;
    if (pid === undefined) {
      throw new BetelgeuzError("runtime.orphan-risk", {
        detail:
          "the run's process identity was never recorded, so it cannot be signalled or proven stopped",
      });
    }
    if (!(await this.probeAlive(pid))) {
      const outcome: RunOutcome = {};
      this.settleOrphan(outcome);
      return outcome;
    }
    await this.signalGroup(pid, "TERM");
    if (await this.waitUntilGone(pid, Math.max(graceMs, 0))) {
      const outcome: RunOutcome = { signal: "TERM" };
      this.settleOrphan(outcome);
      return outcome;
    }
    await this.signalGroup(pid, "KILL");
    if (await this.waitUntilGone(pid, KILL_CONFIRM_MS)) {
      const outcome: RunOutcome = { signal: "KILL" };
      this.settleOrphan(outcome);
      return outcome;
    }
    throw new BetelgeuzError("runtime.orphan-risk", {
      detail: "the process survived SIGKILL signalling; it cannot be proven stopped",
    });
  }

  private async signalGroup(pid: number, signal: "TERM" | "KILL"): Promise<void> {
    await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "signalProcessGroup", pid, signal }),
      { failure: failWith("runtime.orphan-risk"), step: "process signal" }
    );
  }

  /** An operation that mutates the target must not race an unproven previous
   *  run: reconcile it first so the decision rests on target evidence. */
  private async reconcileOrphan(signal?: AbortSignal): Promise<void> {
    if (this.orphan === undefined) {
      return;
    }
    await this.inspect(undefined, signal);
    if (this.orphan !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail:
          "the previous run is still active on the target; stop it before starting another",
      });
    }
  }

  /** Polls the recorded pid until it is gone or the budget runs out. */
  private async waitUntilGone(pid: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (!(await this.probeAlive(pid))) {
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await sleep(Math.min(ORPHAN_POLL_MS, remaining));
    }
  }

  async restart(
    configuration: unknown,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<StrategyRun> {
    const settings = parseApplicationConfiguration(configuration);
    throwIfAborted(signal, "lifecycle");
    await this.stop(settings, settings.stopGraceMs);
    throwIfAborted(signal, "lifecycle");
    return await this.start(configuration, onOutput, signal);
  }

  /**
   * The source of truth for target state (plan §6: "inspect remains the source
   * of truth after reconnect"). A channel that ended without an exit status
   * leaves the run orphaned — the process may be dead or alive — so this asks
   * the target, never the dead channel, and settles the run's outcome with
   * what it proves:
   *
   * - gone by probe time → `exited` with an empty outcome ("exit details were
   *   not observed"),
   * - alive → `running`, leaving cleanup to `stop`,
   * - nothing recorded to probe → `runtime.orphan-risk`; this method never
   *   guesses a state it cannot prove.
   */
  /** Status needs no configuration; the parameter exists so every strategy
   *  operation has the same shape. */
  async inspect(configuration: unknown, signal?: AbortSignal): Promise<StatusResult> {
    void configuration;
    const orphan = this.orphan;
    if (orphan === undefined) {
      return this.observedStatus();
    }
    if (orphan.pid === undefined) {
      throw new BetelgeuzError("runtime.orphan-risk", {
        detail:
          "the run's process identity was never recorded, so its state cannot be proven",
      });
    }
    if (await this.probeAlive(orphan.pid, signal)) {
      // Still running on the target, but its output channel is gone.
      return { state: "running" };
    }
    const outcome: RunOutcome = {};
    this.settleOrphan(outcome);
    return { state: "exited", outcome };
  }

  /** What the channel and history alone prove — the `inspect` fallback when
   *  no run is awaiting reconciliation. */
  private observedStatus(): ApplicationStatus {
    if (this.active !== undefined) {
      return { state: "running" };
    }
    if (this.lastOutcome !== undefined) {
      return { state: "exited", outcome: this.lastOutcome };
    }
    return { state: "stopped" };
  }

  private async probeAlive(pid: number, signal?: AbortSignal): Promise<boolean> {
    const output = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "probeProcess", pid }),
      { failure: failWith("runtime.orphan-risk"), signal, step: "process probe" }
    );
    return output.trim() === "alive";
  }

  /** Resolves the orphaned run's completion and records its outcome. */
  private settleOrphan(outcome: RunOutcome): void {
    const orphan = this.orphan;
    this.orphan = undefined;
    if (orphan === undefined) {
      return;
    }
    this.lastOutcome = outcome;
    orphan.settle(outcome);
  }

  /** Clears per-attach runtime history after the shared session is closed. */
  reset(): void {
    if (this.active !== undefined || this.mutation.held) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "cannot reset an active application run",
      });
    }
    this.resetForcibly();
  }

  /**
   * Clears per-attach state when the owning session is already gone. A dropped
   * channel can never complete a pending operation, so the busy guard protects
   * nothing here — but the next attach must not read output that belonged to the
   * dead one, or be refused by a run it can no longer reach.
   */
  resetForcibly(): void {
    this.mutation.clear();
    this.active = undefined;
    this.lastOutcome = undefined;
    this.nextCursor = 0;
    this.ring.length = 0;
    this.ringTotalBytes = 0;
    const orphan = this.orphan;
    this.orphan = undefined;
    if (orphan !== undefined) {
      // The run is discarded with its fate unproven: say so rather than
      // leaving its outcome promise unsettled or claiming a stop.
      orphan.fail(
        new BetelgeuzError("runtime.orphan-risk", {
          detail:
            "the run was discarded after its channel died, with its process state unproven",
        })
      );
    }
  }

  /** Logs come from the host-side ring, so no configuration is read; the
   *  parameter exists so every strategy operation has the same shape. */
  async logs(
    configuration: unknown,
    cursor?: string | null,
    maxBytes = DEFAULT_RING_BYTES
  ): Promise<LogsResult> {
    void configuration;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new BetelgeuzError("config.invalid", {
        detail: "log maxBytes must be a positive integer",
      });
    }
    const after = cursor === undefined || cursor === null ? -1 : parseCursor(cursor);
    const chunks: Array<OutputChunk> = [];
    let total = 0;
    let nextCursor: number | undefined;
    for (const entry of this.ring) {
      // `<`, not `<=`: the cursor names the next chunk to emit.
      if (entry.cursor < after) {
        continue;
      }
      // Whole chunks only: a truncated chunk would lose its tail on the next
      // page, because the cursor names a chunk, not an offset in one. The
      // first chunk of a page is always emitted so a caller can make progress
      // even when it exceeds maxBytes.
      if (total > 0 && total + entry.chunk.bytes.length > maxBytes) {
        nextCursor = entry.cursor;
        break;
      }
      chunks.push({ bytes: [...entry.chunk.bytes], stream: entry.chunk.stream });
      total += entry.chunk.bytes.length;
    }
    return nextCursor === undefined ? { chunks } : { chunks, nextCursor: String(nextCursor) };
  }

  private launchRequest(configuration: SshApplicationConfiguration): ExecRequest {
    const executable = validAbsolutePath(
      configuration.executable ?? configuration.remotePath,
      "executable"
    );
    const remotePath = validAbsolutePath(configuration.remotePath, "remotePath");
    const cwd = configuration.cwd === undefined
      ? dirname(remotePath)
      : validAbsolutePath(configuration.cwd, "cwd");
    const environment: Record<string, Secret> = {};
    try {
      for (const [name, value] of Object.entries(configuration.environment ?? {})) {
        environment[name] = new Secret(value);
      }
      return ExecRequest.launch({
        allocatePty: false,
        argv: [...(configuration.args ?? [])],
        cwd,
        environment,
        executable,
      });
    } finally {
      for (const value of Object.values(environment)) {
        value.wipe();
      }
    }
  }

  private async consume(
    run: ActiveRun,
    resolve: (outcome: RunOutcome) => void,
    reject: (error: unknown) => void,
    onOutput?: OutputListener
  ): Promise<void> {
    try {
      let outcome: RunOutcome | undefined;
      /** Stdout bytes held while they could still turn out to be the
       *  launcher's pid marker; bounded by MAX_MARKER_LINE_BYTES. */
      let pending: Buffer | undefined;
      let markerDone = false;
      const emit = (stream: OutputStream, bytes: Buffer): void => {
        if (bytes.length === 0) {
          return;
        }
        const chunk: OutputChunk = { bytes: Array.from(bytes), stream };
        this.appendLog(chunk);
        onOutput?.(chunk);
      };
      for (;;) {
        const event = await run.handle.nextEvent();
        if (event === null) {
          break;
        }
        if (event.kind === "output") {
          if (event.stream !== "stdout" || markerDone) {
            emit(event.stream, event.bytes);
            continue;
          }
          const data =
            pending === undefined ? event.bytes : Buffer.concat([pending, event.bytes]);
          pending = undefined;
          const newline = data.indexOf(0x0a);
          if (newline < 0) {
            if (data.length > MAX_MARKER_LINE_BYTES || !couldBeMarkerPrefix(data)) {
              // Not the marker: everything held back was application output.
              markerDone = true;
              emit("stdout", data);
            } else {
              pending = data;
            }
            continue;
          }
          markerDone = true;
          const pid = parseLaunchPidLine(data.subarray(0, newline).toString("latin1"));
          if (pid === undefined) {
            // The first line was ordinary output; nothing is stripped.
            emit("stdout", data);
            continue;
          }
          run.pid = pid;
          emit("stdout", data.subarray(newline + 1));
        } else {
          outcome = {
            ...(event.status === undefined ? {} : { status: event.status }),
            ...(event.signal === undefined ? {} : { signal: event.signal }),
          };
        }
      }
      if (pending !== undefined) {
        markerDone = true;
        emit("stdout", pending);
      }
      if (outcome === undefined) {
        if (this.active === run) {
          // The channel ended without an exit status. The process may still be
          // running: hold the run as an orphan and let a target probe — never
          // the dead channel — decide its fate (plan §4).
          this.active = undefined;
          this.orphan = run;
          return;
        }
        // An abandoned run's channel died after its attach was discarded.
        throw new BetelgeuzError("ssh.lost", {
          detail: "the foreground process channel closed without an exit status",
        });
      }
      if (this.active === run) {
        this.lastOutcome = outcome;
      }
      resolve(outcome);
    } catch (error) {
      reject(error instanceof BetelgeuzError ? error : new BetelgeuzError("ssh.lost", { cause: error }));
    } finally {
      // A run orphaned by abandonAttach still settles later; it must not clear
      // the run that replaced it.
      if (this.active === run) {
        this.active = undefined;
      }
    }
  }

  private appendLog(chunk: OutputChunk): void {
    const stored: OutputChunk = { bytes: Array.from(chunk.bytes), stream: chunk.stream };
    this.ring.push({ cursor: this.nextCursor++, chunk: stored });
    this.ringTotalBytes += stored.bytes.length;
    while (this.ringTotalBytes > DEFAULT_RING_BYTES && this.ring.length > 0) {
      const removed = this.ring.shift();
      this.ringTotalBytes -= removed?.chunk.bytes.length ?? 0;
    }
  }

  private async removeStaging(path: string): Promise<void> {
    try {
      await this.transport.remove(path);
    } catch {
      // Cleanup is best effort; the original deployment error is more useful.
    }
  }

  private async readRuntimeProbe(signal?: AbortSignal): Promise<RuntimeProbe> {
    const output = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "readRuntimeProbe" }),
      { failure: failWith("artifact.runtime-probe-failed"), signal, step: "target probe" }
    );
    const fields = parseFields(output);
    const elfClass = fields.elfClass === "32" ? 1 : fields.elfClass === "64" ? 2 : undefined;
    const endian = fields.endianness === "little" || fields.endianness === "big"
      ? fields.endianness
      : undefined;
    return {
      elfClass,
      endian,
      interpreter: fields.interpreter,
      machine: fields.machine === undefined ? undefined : normalizeMachine(fields.machine),
    };
  }

  private async preflight(
    directory: string,
    signal?: AbortSignal
  ): Promise<DestinationPreflight> {
    const output = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "preflightDestination", directory }),
      { failure: failWith("deploy.preflight-failed"), signal, step: "target probe" }
    );
    const fields = parseFields(output);
    const freeBytes = fields.freeBytes === undefined ? undefined : Number(fields.freeBytes);
    return {
      freeBytes: freeBytes !== undefined && Number.isSafeInteger(freeBytes) ? freeBytes : undefined,
      noexec: fields.noexec === "yes" ? true : fields.noexec === "no" ? false : undefined,
      writable: fields.writable === "yes" ? true : fields.writable === "no" ? false : undefined,
    };
  }

  /** Creates the destination directory so the preflight judges permissions
   *  rather than absence. */
  private async ensureDirectory(directory: string, signal: AbortSignal | undefined): Promise<void> {
    await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "makeDirectory", directory }),
      { failure: failWith("deploy.preflight-failed"), signal, step: "mkdir" }
    );
  }

  /**
   * Configuration-only validation: the target-side runtime checks live in
   * `deploy` (the Phase 1 behavior), so a bind-time probe never opens a
   * session on the application strategy's behalf.
   */
  async validate(configuration: unknown): Promise<void> {
    parseApplicationConfiguration(configuration);
  }

  /** The application strategy owns no target identity beyond the shared
   *  binding (host key and descriptor pins), which the core re-validates on
   *  every reconnect — so there is nothing strategy-specific to assert. */
  async assertIdentity(): Promise<void> {}

  /** Plan §6: a strategy that cannot retain or restore reports the operation
   *  unavailable rather than pretending to offer it. */
  async restorePrevious(): Promise<void> {
    throw new BetelgeuzError("strategy.unsupported-target", {
      detail: "linux.ssh-app does not retain previous versions; restore is unavailable",
    });
  }

  /** An explicit disconnect stops the foreground run it owns: a foreground
   *  process is execution state tied to this session, and stopping it must
   *  succeed before the session is closed — unless another mutating operation
   *  is already in flight, which refuses the disconnect. */
  async release(): Promise<void> {
    await this.stop(undefined).catch((error: unknown) => {
      if (error instanceof BetelgeuzError && error.code === "deploy.busy") {
        throw error;
      }
      return undefined;
    });
  }
}

function describePreflightFailure(preflight: DestinationPreflight, size: number): string {
  if (preflight.writable !== true) {
    return "the destination directory is not writable";
  }
  if (preflight.noexec === true) {
    return "the destination filesystem is mounted noexec";
  }
  if (preflight.noexec === undefined) {
    return "the destination filesystem noexec state could not be determined";
  }
  if (preflight.freeBytes !== undefined && preflight.freeBytes < size) {
    return "the destination filesystem does not have enough free space";
  }
  return "the destination filesystem failed deployment preflight";
}

function validAbsolutePath(value: string, field: string): string {
  if (value.trim() === "" || !value.startsWith("/") || value.includes("\0")) {
    throw new BetelgeuzError("config.invalid", {
      detail: `${field} must be a non-empty absolute path without NUL bytes`,
    });
  }
  return value;
}

function parseMode(value: string | number | undefined): number {
  if (value === undefined) {
    return 0o755;
  }
  const text = typeof value === "number" ? String(value) : value;
  if (!/^[0-7]{3,4}$/.test(text)) {
    throw new BetelgeuzError("config.invalid", {
      detail: "fileMode must be an octal mode such as 0755",
    });
  }
  const mode = Number.parseInt(text, 8);
  if (mode > 0o7777) {
    throw new BetelgeuzError("config.invalid", { detail: "fileMode is out of range" });
  }
  return mode;
}

function parseCursor(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new BetelgeuzError("config.invalid", { detail: "log cursor must be an integer" });
  }
  return Number(value);
}

type RaceResult<T> = { kind: "timeout" } | { kind: "value"; value: T };

async function raceCompletion<T>(promise: Promise<T>, timeoutMs: number): Promise<RaceResult<T>> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new BetelgeuzError("config.invalid", { detail: "stopGraceMs must be non-negative" });
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      new Promise<RaceResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Parses this strategy's settings from the untrusted configuration record:
 * the path and the structured launch values a foreground run needs. A path
 * must be absolute and NUL-free because it is encoded into the launcher
 * command by the transport's quoting layer.
 */
export function parseApplicationConfiguration(value: unknown): ApplicationConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BetelgeuzError("config.invalid", {
      detail: "the strategy configuration must be an object",
    });
  }
  const record = value as Record<string, unknown>;
  const remotePath = validAbsolutePath(
    requireString(record.remotePath, "remotePath"),
    "remotePath"
  );
  const args = optionalStringArray(record.args, "args");
  const environment = optionalStringMap(record.environment, "environment");
  const cwd = optionalString(record.cwd, "cwd");
  const executable = optionalString(record.executable, "executable");
  const fileMode = optionalString(record.fileMode, "fileMode");
  const stopGraceMs = record.stopGraceMs;
  if (
    stopGraceMs !== undefined &&
    (!Number.isInteger(stopGraceMs) || (stopGraceMs as number) < 0)
  ) {
    throw new BetelgeuzError("config.invalid", {
      detail: "stopGraceMs must be a non-negative integer",
    });
  }
  return {
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(environment === undefined ? {} : { environment }),
    ...(executable === undefined ? {} : { executable }),
    ...(fileMode === undefined ? {} : { fileMode }),
    remotePath,
    ...(stopGraceMs === undefined ? {} : { stopGraceMs: stopGraceMs as number }),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BetelgeuzError("config.invalid", {
      detail: `${field} must be a non-empty string`,
    });
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new BetelgeuzError("config.invalid", {
      detail: `${field} must be a string`,
    });
  }
  return value === "" ? undefined : value;
}

function optionalStringArray(value: unknown, field: string): Array<string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BetelgeuzError("config.invalid", {
      detail: `${field} must be an array of strings`,
    });
  }
  return [...(value as Array<string>)];
}

function optionalStringMap(
  value: unknown,
  field: string
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BetelgeuzError("config.invalid", {
      detail: `${field} must be an object of string values`,
    });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new BetelgeuzError("config.invalid", {
      detail: `${field} must be an object of string values`,
    });
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Builds the failure a fixed probe reports: the shared runner detects the
 *  failure, the strategy owns the code it surfaces. */
function failWith(code: ErrorCode): (detail: string) => BetelgeuzError {
  return (detail) => new BetelgeuzError(code, { detail });
}

/** True while `data` could still grow into the launcher's pid marker line.
 *  The strategy holds output back only this long; anything else is application
 *  output from its first byte. */
function couldBeMarkerPrefix(data: Buffer): boolean {
  const text = data.toString("latin1");
  const head = `${LAUNCH_PID_MARKER}\t`;
  return head.startsWith(text) || (text.startsWith(head) && /^[0-9]*$/.test(text.slice(head.length)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
