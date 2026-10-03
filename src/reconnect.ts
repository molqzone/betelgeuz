/**
 * Automatic session recovery: the bounded reconnect policy.
 *
 * A dropped SSH session is not the end of the attach — the plan keeps the
 * binding and re-establishes the connection under a bounded retry budget
 * (§3, "an established connection that drops triggers bounded automatic
 * reconnect without user action"). This module owns the policy: how long to
 * wait between attempts, how many attempts are allowed, and which failures
 * are worth retrying at all (the catalog's `retriable` flag decides that —
 * an authentication failure does not become valid by trying again).
 *
 * What happens on each attempt — loading credentials, re-verifying identity,
 * restoring the UI — belongs to the caller; an explicit `Disconnect` stops
 * the retries by aborting the signal.
 */
import { throwIfAborted } from "./cancellation";
import { BetelgeuzError, errorDef } from "./errors";

/** Total attempts, including the first one (which runs immediately). */
export const RECONNECT_MAX_ATTEMPTS = 5;

/** Delay before the first retry; each further retry doubles it. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_BACKOFF_FACTOR = 2;

/** Ceiling on the growing delay, so a long outage stays responsive to a
 *  user's `Connect` or `Disconnect` instead of sleeping for minutes. */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** Wait before retry number `retry` (1-based: the first retry follows the
 *  first failure). Exponential, capped — E2 requires named bounds. */
export function reconnectDelayMs(retry: number): number {
  const growth = RECONNECT_BASE_DELAY_MS * RECONNECT_BACKOFF_FACTOR ** (retry - 1);
  return Math.min(growth, RECONNECT_MAX_DELAY_MS);
}

/** A cancellable pause between attempts. Aborting rejects promptly with
 *  `operation.cancelled` instead of waiting out the delay. */
export function waitToReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelled(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      cleanup();
      reject(cancelled(signal));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type ReconnectOptions = {
  /** Stops the retries on abort — the explicit `Disconnect` path. */
  signal?: AbortSignal;
  /** Observability hook for the caller's log; not part of the policy. */
  onRetry?: (error: unknown, retry: number, delayMs: number) => void;
};

/**
 * Runs `attempt` until it succeeds or the budget is spent. The first attempt
 * is immediate; retries are separated by `reconnectDelayMs`. Only failures the
 * catalog marks retriable are retried; anything else is final and thrown at
 * once (wrapped as `internal.unexpected` when it is not a catalog error).
 */
export async function runReconnect<T>(
  attempt: () => Promise<T>,
  options: ReconnectOptions = {}
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    throwIfAborted(options.signal, "connect");
    try {
      return await attempt();
    } catch (error) {
      const failure =
        error instanceof BetelgeuzError
          ? error
          : BetelgeuzError.wrapUnexpected("connect", error);
      const spent = retry + 1 >= RECONNECT_MAX_ATTEMPTS;
      if (!errorDef(failure.code).retriable || spent) {
        throw failure;
      }
      const delayMs = reconnectDelayMs(retry + 1);
      options.onRetry?.(failure, retry + 1, delayMs);
      await waitToReconnect(delayMs, options.signal);
    }
  }
}

function cancelled(signal?: AbortSignal): BetelgeuzError {
  return new BetelgeuzError("operation.cancelled", {
    phase: "connect",
    cause: signal?.reason,
  });
}
