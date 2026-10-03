import { describe, expect, it, vi } from "vitest";

import { BetelgeuzError } from "../errors";
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  reconnectDelayMs,
  runReconnect,
  waitToReconnect,
} from "../reconnect";

describe("reconnect policy", () => {
  it("grows the delay exponentially and caps it", () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(2)).toBe(RECONNECT_BASE_DELAY_MS * 2);
    expect(reconnectDelayMs(3)).toBe(RECONNECT_BASE_DELAY_MS * 4);
    // The cap holds no matter how large the retry number is.
    expect(reconnectDelayMs(64)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it("retries retriable failures and succeeds within the budget", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const succeeded = runReconnect(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new BetelgeuzError("ssh.unreachable");
        }
        return "connected";
      });
      await vi.runAllTimersAsync();
      await expect(succeeded).resolves.toBe("connected");
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at the attempt limit and reports the last failure", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const failing = runReconnect(async () => {
        attempts += 1;
        throw new BetelgeuzError("ssh.unreachable");
      });
      const rejection = expect(failing).rejects.toMatchObject({
        code: "ssh.unreachable",
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(attempts).toBe(RECONNECT_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a failure the catalog marks final", async () => {
    let attempts = 0;
    await expect(
      runReconnect(async () => {
        attempts += 1;
        throw new BetelgeuzError("ssh.auth-failed");
      })
    ).rejects.toMatchObject({ code: "ssh.auth-failed" });
    expect(attempts).toBe(1);
  });

  it("collapses a non-catalog throw into internal.unexpected without retrying", async () => {
    let attempts = 0;
    await expect(
      runReconnect(async () => {
        attempts += 1;
        throw new Error("socket exploded");
      })
    ).rejects.toMatchObject({ code: "internal.unexpected" });
    expect(attempts).toBe(1);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("user cancelled");
    let attempts = 0;
    await expect(
      runReconnect(
        async () => {
          attempts += 1;
          return "connected";
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: "operation.cancelled" });
    expect(attempts).toBe(0);
  });

  it("cancellation timing: an abort during the wait rejects promptly", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let attempts = 0;
      const running = runReconnect(
        async () => {
          attempts += 1;
          throw new BetelgeuzError("ssh.unreachable");
        },
        { signal: controller.signal }
      );
      const rejection = expect(running).rejects.toMatchObject({
        code: "operation.cancelled",
      });
      // Let the first attempt fail and the retry delay start.
      await vi.advanceTimersByTimeAsync(0);
      // Abort mid-wait: the promise must settle without advancing the clock
      // through the full delay.
      controller.abort("user cancelled");
      await rejection;
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitToReconnect resolves after the delay and rejects on abort", async () => {
    vi.useFakeTimers();
    try {
      const waiting = waitToReconnect(5_000);
      const settled = vi.fn();
      void waiting.then(settled);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;

      const controller = new AbortController();
      const cancelledWait = waitToReconnect(5_000, controller.signal);
      const rejection = expect(cancelledWait).rejects.toMatchObject({
        code: "operation.cancelled",
      });
      controller.abort("user cancelled");
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
