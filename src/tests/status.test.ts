/**
 * The status copy is what the user reads to choose their next action, so its
 * shape is pinned here rather than left to drift behind a real board run —
 * the exact failure that let the surface rename a toast while the acceptance
 * suites still looked for the old wording.
 */
import { describe, expect, it } from "vitest";

import type { StatusResult } from "../protocol";
import { describeOutcome, statusSentence } from "../surface/status";

describe("describeOutcome", () => {
  it("names the exit status when it was observed", () => {
    expect(describeOutcome({ status: 7 })).toBe("status 7");
    expect(describeOutcome({ status: 0 })).toBe("status 0");
  });

  it("names the terminating signal when there was one", () => {
    expect(describeOutcome({ signal: "KILL" })).toBe("signal KILL");
  });

  it("names the gap when neither was observed", () => {
    expect(describeOutcome({})).toBe("status not observed");
  });
});

describe("statusSentence", () => {
  const status = (state: string, more: Partial<StatusResult> = {}): StatusResult => ({
    state,
    ...more,
  });

  it("reads the running state as a sentence and carries the strategy's detail", () => {
    expect(
      statusSentence("Linux small-core firmware", status("running", {
        detail: "cv181x-c906_1; firmware rtos.elf",
      }))
    ).toBe(
      "Betelgeuz: Linux small-core firmware is running (cv181x-c906_1; firmware rtos.elf)."
    );
    expect(statusSentence("Linux application", status("running")))
      .toBe("Betelgeuz: Linux application is running.");
  });

  it("reports an exit with its outcome, and the unobserved exit as exactly that", () => {
    expect(statusSentence("Linux application", status("exited", { outcome: { status: 0 } })))
      .toBe("Betelgeuz: Linux application exited (status 0).");
    expect(statusSentence("Linux application", status("exited", { outcome: { signal: "KILL" } })))
      .toBe("Betelgeuz: Linux application exited (signal KILL).");
    expect(statusSentence("Linux application", status("exited", { outcome: {} })))
      .toBe("Betelgeuz: Linux application exited (status not observed).");
    expect(statusSentence("Linux application", status("exited")))
      .toBe("Betelgeuz: Linux application exited.");
  });

  it("reads the small-core lifecycle words as sentences", () => {
    expect(statusSentence("Linux small-core firmware", status("stopped")))
      .toBe("Betelgeuz: Linux small-core firmware is stopped.");
    expect(statusSentence("Linux small-core firmware", status("crashed")))
      .toBe("Betelgeuz: Linux small-core firmware has crashed.");
    expect(statusSentence("Linux small-core firmware", status("suspended")))
      .toBe("Betelgeuz: Linux small-core firmware is suspended.");
  });

  it("shows a strategy's own vocabulary as reported rather than guessing at it", () => {
    expect(statusSentence("Fancy core", status("degraded")))
      .toBe("Betelgeuz: Fancy core — degraded.");
    // The outcome and the detail both ride along, separated, in the order
    // they mean something: how it ended, then what was selected.
    expect(statusSentence("Fancy core", status("degraded", {
      outcome: { status: 1 },
      detail: "cv181x-c906_1",
    }))).toBe("Betelgeuz: Fancy core — degraded (status 1; cv181x-c906_1).");
  });
});
