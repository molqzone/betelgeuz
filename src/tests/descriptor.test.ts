import { describe, expect, it, vi } from "vitest";

import { BetelgeuzError } from "../errors";
import { ExecHandle, type ExecRequest } from "../transport";
import { FakeSshTransport } from "../transport/fake";
import {
  assertDescriptorMatches,
  parseHardwareDescriptor,
  readHardwareDescriptor,
  type HardwareDescriptor,
} from "../protocol/descriptor";

describe("hardware descriptor shape", () => {
  it("tolerates missing fields as unknown", () => {
    const descriptor: HardwareDescriptor = {
      deviceId: "abc-123",
      socId: "rk3506",
      model: "my-board",
    };
    expect(JSON.stringify(descriptor, null, 2)).toMatchInlineSnapshot(`
      "{
        "deviceId": "abc-123",
        "socId": "rk3506",
        "model": "my-board"
      }"
    `);
    const empty: HardwareDescriptor = {};
    expect(empty.deviceId).toBeUndefined();
  });

  it("parses the fixed Linux fallback format and normalizes empty fields", () => {
    expect(
      parseHardwareDescriptor(
        "model\tLichee RV-Nano\0\nsocId\trk3506\ndeviceId\t\n"
      )
    ).toEqual({
      model: "Lichee RV-Nano",
      socId: "rk3506",
      compatible: ["rk3506"],
    });
  });

  it("preserves each device-tree compatible value for identity pin matching", () => {
    const descriptor = parseHardwareDescriptor(
      "socId\tvendor,soc\0vendor,board\0\n"
    );
    expect(descriptor).toEqual({
      socId: "vendor,soc",
      compatible: ["vendor,soc", "vendor,board"],
    });
    expect(() =>
      assertDescriptorMatches(descriptor, { socId: "vendor,board" })
    ).not.toThrow();
  });

  it("rejects malformed or unsafe descriptor values", () => {
    expect(() => parseHardwareDescriptor("not-a-descriptor")).toThrow(
      BetelgeuzError
    );
    expect(() => parseHardwareDescriptor('{"deviceId":42}')).toThrow(
      /deviceId must be a string/
    );
    expect(() =>
      parseHardwareDescriptor(`{"model":"${"x".repeat(513)}"}`)
    ).toThrow(/invalid characters or is too long/);
  });

  it("requires configured identity pins to be present and equal", () => {
    const descriptor: HardwareDescriptor = { deviceId: "board-1", socId: "rk3506" };
    expect(() =>
      assertDescriptorMatches(descriptor, { deviceId: "board-2" })
    ).toThrow(/deviceId pin/);
    expect(() =>
      assertDescriptorMatches(descriptor, { deviceId: "board-1", socId: "rk3506" })
    ).not.toThrow();
  });

  it("bounds a stalled probe, requests termination, and returns a retryable error", async () => {
    class StalledTransport extends FakeSshTransport {
      terminationRequested = false;

      override async exec(_request: ExecRequest): Promise<ExecHandle> {
        return new ExecHandle(() => {
          this.terminationRequested = true;
          return new Promise<void>(() => undefined);
        });
      }
    }

    vi.useFakeTimers();
    const transport = new StalledTransport();
    try {
      const probe = readHardwareDescriptor(transport);
      const rejection = expect(probe).rejects.toMatchObject({
        code: "identity.descriptor-timeout",
        retriable: true,
      });
      await vi.advanceTimersByTimeAsync(10_001);
      await vi.advanceTimersByTimeAsync(251);
      await rejection;
      expect(transport.terminationRequested).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled probe and terminates its remote command", async () => {
    class StalledTransport extends FakeSshTransport {
      terminationRequested = false;

      override async exec(_request: ExecRequest): Promise<ExecHandle> {
        return new ExecHandle(() => {
          this.terminationRequested = true;
        });
      }
    }

    const transport = new StalledTransport();
    const controller = new AbortController();
    const probe = readHardwareDescriptor(transport, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort("user cancelled");
    await expect(probe).rejects.toMatchObject({
      code: "operation.cancelled",
      phase: "identity",
    });
    expect(transport.terminationRequested).toBe(true);
  });

  it("terminates a descriptor channel that opens after cancellation", async () => {
    let resolveExec: ((handle: ExecHandle) => void) | undefined;
    class DelayedTransport extends FakeSshTransport {
      terminationRequested = false;

      override async exec(_request: ExecRequest): Promise<ExecHandle> {
        return await new Promise<ExecHandle>((resolve) => {
          resolveExec = resolve;
        });
      }
    }

    const transport = new DelayedTransport();
    const controller = new AbortController();
    const probe = readHardwareDescriptor(transport, controller.signal);
    controller.abort("user cancelled");
    await expect(probe).rejects.toMatchObject({ code: "operation.cancelled" });
    const handle = new ExecHandle(() => {
      transport.terminationRequested = true;
    });
    resolveExec?.(handle);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.terminationRequested).toBe(true);
  });
});
