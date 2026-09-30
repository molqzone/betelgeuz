/** Shared cancellation vocabulary for core operations that may wait on I/O. */
import { BetelgeuzError, type Phase } from "./errors";

export function throwIfAborted(
  signal: AbortSignal | undefined,
  phase: Phase
): void {
  if (signal?.aborted) {
    throw cancellationError(phase, signal.reason);
  }
}

export function cancellationError(phase: Phase, cause?: unknown): BetelgeuzError {
  return new BetelgeuzError("operation.cancelled", { phase, cause });
}
