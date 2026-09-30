/**
 * Linux userspace application strategy.
 *
 * This module owns the Phase 1 application workflow after the shared SSH
 * attach has verified the board: a host artifact is staged through SFTP and
 * atomically renamed, then a structured foreground exec is kept in a small
 * host-side output ring. It deliberately accepts no free-form shell command.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { cancellationError, throwIfAborted } from "../cancellation";
import {
  assertRuntimeCompatible,
  inspectElf,
  normalizeMachine,
  type ElfClass,
  type ElfEndian,
} from "../artifact/elf";
import { BetelgeuzError } from "../errors";
import type { ApplicationConfiguration, ArtifactRecord, OutputChunk } from "../protocol";
import { Secret } from "../secret";
import {
  ExecRequest,
  type ExecHandle,
  type SshTransport,
} from "../transport";

const DEFAULT_RING_BYTES = 256 * 1024;
const DEFAULT_STOP_GRACE_MS = 5_000;
const MAX_PROBE_BYTES = 16 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export type SshApplicationConfiguration = ApplicationConfiguration;

export type DeploymentResult = {
  previousSize?: number;
  remotePath: string;
};

export type RunOutcome = {
  signal?: string;
  status?: number;
};

export type ApplicationRun = {
  readonly completion: Promise<RunOutcome>;
  readonly runId: string;
};

export type ApplicationStatus = {
  outcome?: RunOutcome;
  state: "exited" | "running" | "stopped";
};

export type OutputListener = (chunk: OutputChunk) => void;

type ActiveRun = {
  readonly completion: Promise<RunOutcome>;
  readonly handle: ExecHandle;
  readonly runId: string;
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
export class SshApplicationStrategy {
  private active?: ActiveRun;
  /** Held while a mutating operation runs; a release only clears the token it was
   * issued with, so an operation that outlived its attach cannot clear a newer one. */
  private mutationToken?: symbol;
  private lastOutcome?: RunOutcome;
  private nextCursor = 0;
  private ringTotalBytes = 0;
  private readonly ring: Array<{ cursor: number; chunk: OutputChunk }> = [];

  constructor(private readonly transport: SshTransport) {}

  async deploy(
    artifact: ArtifactRecord,
    configuration: SshApplicationConfiguration,
    signal?: AbortSignal
  ): Promise<DeploymentResult> {
    throwIfAborted(signal, "deploy");
    if (this.active !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "cannot deploy while the application is running",
      });
    }
    const releaseMutation = this.enterMutation();
    try {
    const remotePath = validAbsolutePath(configuration.remotePath, "remotePath");
    const mode = parseMode(configuration.fileMode);
    const source = await localArtifact(artifact);
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
      if (isAbort(error) || signal?.aborted === true) {
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
    configuration: SshApplicationConfiguration,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<ApplicationRun> {
    throwIfAborted(signal, "lifecycle");
    if (this.active !== undefined || this.mutationToken !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "an application run is already active",
      });
    }
    if (configuration.runMode === "service") {
      throw new BetelgeuzError("runtime.service-manager-missing", {
        detail: configuration.serviceUnit === undefined
          ? "service mode requires a pre-provisioned service unit"
          : `systemd service ${configuration.serviceUnit} is not available in Phase 1`,
      });
    }
    const releaseMutation = this.enterMutation();
    try {
    const request = this.launchRequest(configuration);
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
    this.active = { completion, handle, runId };
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

  async stop(graceMs = DEFAULT_STOP_GRACE_MS): Promise<RunOutcome | undefined> {
    const active = this.active;
    if (active === undefined) {
      if (this.mutationToken !== undefined) {
        throw new BetelgeuzError("deploy.busy", {
          detail: "another mutating operation is already running",
        });
      }
      return this.lastOutcome;
    }
    const releaseMutation = this.enterMutation();
    try {
      await active.handle.terminate();
      const finished = await raceCompletion(active.completion, graceMs);
      if (finished.kind === "value") {
        return finished.value;
      }
      await active.handle.kill();
      return await active.completion;
    } finally {
      releaseMutation();
    }
  }

  async restart(
    configuration: SshApplicationConfiguration,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<ApplicationRun> {
    throwIfAborted(signal, "lifecycle");
    await this.stop(configuration.stopGraceMs);
    throwIfAborted(signal, "lifecycle");
    return await this.start(configuration, onOutput, signal);
  }

  status(): ApplicationStatus {
    if (this.active !== undefined) {
      return { state: "running" };
    }
    if (this.lastOutcome !== undefined) {
      return { state: "exited", outcome: this.lastOutcome };
    }
    return { state: "stopped" };
  }

  /** Clears per-attach runtime history after the shared session is closed. */
  reset(): void {
    if (this.active !== undefined || this.mutationToken !== undefined) {
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
    this.mutationToken = undefined;
    this.active = undefined;
    this.lastOutcome = undefined;
    this.nextCursor = 0;
    this.ring.length = 0;
    this.ringTotalBytes = 0;
  }

  logs(cursor?: string | null, maxBytes = DEFAULT_RING_BYTES): {
    chunks: Array<OutputChunk>;
    nextCursor?: string;
  } {
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
      for (;;) {
        const event = await run.handle.nextEvent();
        if (event === null) {
          break;
        }
        if (event.kind === "output") {
          const chunk: OutputChunk = {
            bytes: Array.from(event.bytes),
            stream: event.stream,
          };
          this.appendLog(chunk);
          onOutput?.(chunk);
        } else {
          outcome = {
            ...(event.status === undefined ? {} : { status: event.status }),
            ...(event.signal === undefined ? {} : { signal: event.signal }),
          };
        }
      }
      if (outcome === undefined) {
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

  private enterMutation(): () => void {
    if (this.mutationToken !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "another mutating operation is already running",
      });
    }
    const token = Symbol("mutation");
    this.mutationToken = token;
    return () => {
      if (this.mutationToken === token) {
        this.mutationToken = undefined;
      }
    };
  }

  private async readRuntimeProbe(signal?: AbortSignal): Promise<RuntimeProbe> {
    const output = await this.fixedProbe(
      ExecRequest.fixed({ kind: "readRuntimeProbe" }),
      signal,
      "artifact.runtime-probe-failed"
    );
    const fields = parseProbeFields(output);
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
    const output = await this.fixedProbe(
      ExecRequest.fixed({ kind: "preflightDestination", directory }),
      signal,
      "deploy.preflight-failed"
    );
    const fields = parseProbeFields(output);
    const freeBytes = fields.freeBytes === undefined ? undefined : Number(fields.freeBytes);
    return {
      freeBytes: freeBytes !== undefined && Number.isSafeInteger(freeBytes) ? freeBytes : undefined,
      noexec: fields.noexec === "yes" ? true : fields.noexec === "no" ? false : undefined,
      writable: fields.writable === "yes" ? true : fields.writable === "no" ? false : undefined,
    };
  }

  /** Creates the destination directory so the preflight judges permissions
   * rather than absence. */
  private async ensureDirectory(directory: string, signal: AbortSignal | undefined): Promise<void> {
    await this.runFixed(
      ExecRequest.fixed({ kind: "makeDirectory", directory }),
      signal,
      "deploy.preflight-failed",
      "mkdir"
    );
  }

  private async fixedProbe(
    request: ExecRequest,
    signal: AbortSignal | undefined,
    failureCode: "artifact.runtime-probe-failed" | "deploy.preflight-failed"
  ): Promise<string> {
    return await this.runFixed(request, signal, failureCode, "target probe");
  }

  private async runFixed(
    request: ExecRequest,
    signal: AbortSignal | undefined,
    failureCode: "artifact.runtime-probe-failed" | "deploy.preflight-failed",
    step: string
  ): Promise<string> {
    throwIfAborted(signal, "deploy");
    const handle = await this.transport.exec(request);
    const chunks: Array<Buffer> = [];
    let total = 0;
    let exit: Extract<Awaited<ReturnType<ExecHandle["nextEvent"]>>, { kind: "exit" }> | undefined;
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new BetelgeuzError(failureCode, {
            detail: `${step} exceeded ${PROBE_TIMEOUT_MS} ms`,
          });
        }
        const event = await nextProbeEvent(handle, remaining, signal, failureCode, step);
        if (event === null) {
          break;
        }
        if (event.kind === "output" && event.stream === "stdout") {
          total += event.bytes.byteLength;
          if (total > MAX_PROBE_BYTES) {
            throw new BetelgeuzError(failureCode, {
              detail: `${step} exceeded its output limit`,
            });
          }
          chunks.push(event.bytes);
        } else if (event.kind === "exit") {
          exit = event;
        }
      }
      if (exit?.status !== 0) {
        throw new BetelgeuzError(failureCode, {
          detail: `${step} did not complete successfully`,
        });
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      await handle.terminate().catch(() => undefined);
      if (signal?.aborted === true) {
        throw cancellationError("deploy", signal.reason);
      }
      throw error;
    }
  }
}

async function localArtifact(artifact: ArtifactRecord): Promise<{ path: string; size: number }> {
  try {
    const info = await stat(artifact.path);
    if (!info.isFile() || info.size !== artifact.size) {
      throw new BetelgeuzError("artifact.missing", {
        detail: "the artifact path or size no longer matches the build record",
      });
    }
    return { path: artifact.path, size: info.size };
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      throw error;
    }
    throw new BetelgeuzError("artifact.missing", { cause: error });
  }
}

function parseProbeFields(output: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("\t");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== "") {
      fields[key] = value;
    }
  }
  return fields;
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

async function nextProbeEvent(
  handle: ExecHandle,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  failureCode: "artifact.runtime-probe-failed" | "deploy.preflight-failed",
  step: string
): Promise<Awaited<ReturnType<ExecHandle["nextEvent"]>>> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      handle.nextEvent(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BetelgeuzError(failureCode, {
          detail: `${step} timed out`,
        })), timeoutMs);
        if (signal !== undefined) {
          abortListener = () => reject(cancellationError("deploy", signal.reason));
          if (signal.aborted) {
            abortListener();
          } else {
            signal.addEventListener("abort", abortListener, { once: true });
          }
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
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

function isAbort(error: unknown): boolean {
  return error instanceof BetelgeuzError &&
    (error.code === "operation.cancelled" || error.code === "deploy.cancelled");
}
