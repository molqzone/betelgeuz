/**
 * How the surface speaks about the target (plan §7): the strategy reports its
 * own state vocabulary and the surface renders it as a short sentence, never
 * inferring a state the strategy did not report and never inventing an exit
 * the strategy did not observe. The sentences below cover the plan's own
 * running / exited / stopped model plus the small-core lifecycle words; any
 * other strategy vocabulary is shown as reported.
 *
 * Pure data and pure functions on purpose: the copy is what the user reads to
 * decide their next action, so it is pinned by tests instead of drifting
 * behind a real board.
 */
import type { RunOutcome, StatusResult } from "../protocol";

/** How a run ended, as a noun phrase — including its own gap: an outcome with
 *  neither field is an end whose details were never observed, and says so
 *  rather than guessing at a status (plan §5). */
export function describeOutcome(outcome: RunOutcome): string {
  if (outcome.status !== undefined) {
    return `status ${outcome.status}`;
  }
  if (outcome.signal !== undefined) {
    return `signal ${outcome.signal}`;
  }
  return "status not observed";
}

/** The status toast: the strategy's label, its reported state as a sentence,
 *  and whatever the strategy knows about the outcome or the selection — the
 *  process outcome for a foreground run, the instance and firmware for the
 *  small core. */
export function statusSentence(label: string, status: StatusResult): string {
  const notes: Array<string> = [];
  if (status.outcome !== undefined) {
    notes.push(describeOutcome(status.outcome));
  }
  if (status.detail !== undefined) {
    notes.push(status.detail);
  }
  const suffix = notes.length === 0 ? "" : ` (${notes.join("; ")})`;
  switch (status.state) {
    case "running":
      return `Betelgeuz: ${label} is running${suffix}.`;
    case "exited":
      return `Betelgeuz: ${label} exited${suffix}.`;
    case "stopped":
      return `Betelgeuz: ${label} is stopped${suffix}.`;
    case "crashed":
      return `Betelgeuz: ${label} has crashed${suffix}.`;
    case "suspended":
      return `Betelgeuz: ${label} is suspended${suffix}.`;
    case "unknown":
      return `Betelgeuz: ${label} is in an unknown state${suffix}.`;
    default:
      return `Betelgeuz: ${label} — ${status.state}${suffix}.`;
  }
}
