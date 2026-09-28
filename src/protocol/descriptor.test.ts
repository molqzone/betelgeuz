import { describe, expect, it } from "vitest";

import type { HardwareDescriptor } from "./descriptor";

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
});
