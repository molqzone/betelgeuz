/**
 * The shared operation coordinator (plan §6): what every deploy strategy
 * reuses instead of growing its own copy — the busy lock a mutating operation
 * holds, the bounded runner for fixed commands, and the tab-separated field
 * parser the fixed probes answer in.
 *
 * Every part of this module has two real consumers in the tree (`linux.ssh-app`
 * and `linux.remoteproc`); the extraction is that second occurrence, not a
 * forecast (docs/dev abstraction policy).
 */
import type { ExecHandle, ExecRequest, SshTransport } from "./transport";
import { cancellationError, throwIfAborted } from "./cancellation";
import { BetelgeuzError, type Phase } from "./errors";

/** Bound on one fixed command's stdout before it is a failure (E2). */
export const MAX_PROBE_BYTES = 16 * 1024;

/** Deadline for one fixed command: a target that cannot answer a probe within
 *  this budget is reported, not waited on forever (E2). */
export const PROBE_TIMEOUT_MS = 5_000;

export type FixedCommandOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Builds the failure the step reports. The caller owns its codes: a common
   * code is a plain `BetelgeuzError`, while a strategy-owned code comes from
   * the strategy's own factory with its definition — this module never
   * learns a strategy's namespace.
   */
  failure: (detail: string) => BetelgeuzError;
  /** Phase reported for a cancellation, matching the operation in flight. */
  phase?: Phase;
  /** Names the step in the error detail, e.g. "target probe". */
  step: string;
};

/**
 * Runs one fixed command to completion and collects its stdout.
 *
 * The command never allocates a PTY and never detaches: it runs, prints a
 * bounded amount, and exits. A timeout, an output overflow, a non-zero exit,
 * or an abort all surface as catalog errors with the caller's code, and the
 * channel is terminated best-effort so nothing is left running behind them.
 */
export async function runFixedCommand(
  transport: SshTransport,
  request: ExecRequest,
  options: FixedCommandOptions
): Promise<string> {
  const phase = options.phase ?? "deploy";
  throwIfAborted(options.signal, phase);
  const handle = await transport.exec(request);
  const chunks: Array<Buffer> = [];
  let total = 0;
  let exit: Extract<Awaited<ReturnType<ExecHandle["nextEvent"]>>, { kind: "exit" }> | undefined;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PROBE_BYTES;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw options.failure(`${options.step} exceeded ${timeoutMs} ms`);
      }
      const event = await nextEvent(handle, remaining, options.signal, options, phase);
      if (event === null) {
        break;
      }
      if (event.kind === "output" && event.stream === "stdout") {
        total += event.bytes.byteLength;
        if (total > maxBytes) {
          throw options.failure(`${options.step} exceeded its output limit`);
        }
        chunks.push(event.bytes);
      } else if (event.kind === "exit") {
        exit = event;
      }
    }
    if (exit?.status !== 0) {
      throw options.failure(`${options.step} did not complete successfully`);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    await handle.terminate().catch(() => undefined);
    if (options.signal?.aborted === true) {
      throw cancellationError(phase, options.signal.reason);
    }
    throw error;
  }
}

async function nextEvent(
  handle: ExecHandle,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  options: FixedCommandOptions,
  phase: Phase
): Promise<Awaited<ReturnType<ExecHandle["nextEvent"]>>> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      handle.nextEvent(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(options.failure(`${options.step} timed out`)),
          timeoutMs
        );
        if (signal !== undefined) {
          abortListener = () => reject(cancellationError(phase, signal.reason));
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

/**
 * Mutual exclusion for mutating operations (plan §6: one mutating operation
 * per attach at a time, never queued). A release only clears the token it was
 * issued with, so an operation that outlived its attach can never clear a
 * newer operation's lock.
 */
export class MutationLock {
  private token?: symbol;

  /** Throws `deploy.busy` while another mutating operation holds the lock. */
  enter(): () => void {
    if (this.token !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "another mutating operation is already running",
      });
    }
    const token = Symbol("mutation");
    this.token = token;
    return () => {
      if (this.token === token) {
        this.token = undefined;
      }
    };
  }

  /** True while an operation holds the lock. */
  get held(): boolean {
    return this.token !== undefined;
  }

  /** Drops the lock without its owner — only for a session that is already
   *  gone and can never finish the operation that held it. */
  clear(): void {
    this.token = undefined;
  }
}

/**
 * Parses the tab-separated `key\tvalue` lines the fixed probes print. Values
 * may repeat a key only by last-wins; a line without a separator is skipped
 * rather than failing the probe, because probes print partial output on
 * purpose (a missing field is an unknown, not an error).
 */
export function parseFields(output: string): Record<string, string> {
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

/** True for the cancellation vocabulary (`operation.cancelled`,
 *  `deploy.cancelled`) — a user stop, never a target failure. */
export function isCancellation(error: unknown): boolean {
  return (
    error instanceof BetelgeuzError &&
    (error.code === "operation.cancelled" || error.code === "deploy.cancelled")
  );
}

/** An abort-aware pause between bounded polls. Rejects promptly with
 *  `operation.cancelled` instead of waiting out the delay. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancellationError("deploy", signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(cancellationError("deploy", signal?.reason));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
