import { describe, expect, it } from "vitest";

import { BetelgeuzError } from "./errors";
import { resolveProfile } from "./profile";
import type { ProfileCatalog, TargetOverrides } from "./protocol";

const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function catalog(): ProfileCatalog {
  return {
    board: {
      host: "board.local",
      port: 2222,
      username: "root",
      credentialRef: "board-key",
      hostKey: PIN,
      deviceId: "board-1",
      socId: "rk3506",
      keepaliveSeconds: 15,
      proxyChain: [],
    },
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a BetelgeuzError");
}

describe("resolveProfile", () => {
  it("workspace overrides win and blank values inherit", () => {
    const resolved = resolveProfile(catalog(), {
      profile: "board",
      host: "  ",
      username: "operator",
      credentialRef: "",
    });
    expect(resolved.host).toBe("board.local");
    expect(resolved.username).toBe("operator");
    expect(resolved.credentialRef).toBe("board-key");
    expect(resolved.profileName).toBe("board");
    expect(resolved.port).toBe(2222);
    expect(resolved.keepaliveSeconds).toBe(15);
  });

  it("resolves inline settings without a named profile", () => {
    const resolved = resolveProfile({}, {
      host: "board.local",
      username: "root",
      credentialRef: "board",
    });
    expect(resolved.profileName).toBeUndefined();
    expect(resolved.port).toBe(22);
    expect(resolved.keepaliveSeconds).toBe(30);
    expect(resolved.hostKey).toBeUndefined();
  });

  it("fails on unknown profiles and incomplete settings", () => {
    expect(codeOf(() => resolveProfile({}, { profile: "missing" }))).toBe(
      "profile.unresolved"
    );
    expect(codeOf(() => resolveProfile({}, { host: "board.local" }))).toBe(
      "profile.unresolved"
    );
  });

  it("rejects invalid port, keepalive, and unprintable hosts", () => {
    const base: TargetOverrides = {
      host: "board.local",
      username: "root",
      credentialRef: "board",
    };
    expect(codeOf(() => resolveProfile({}, { ...base, port: 0 }))).toBe(
      "config.invalid"
    );
    expect(
      codeOf(() => resolveProfile({}, { ...base, keepaliveSeconds: 0 }))
    ).toBe("config.invalid");
    expect(
      codeOf(() => resolveProfile({}, { ...base, host: "board local" }))
    ).toBe("config.invalid");
  });

  it("requires every proxy hop to carry a pin and a credential reference", () => {
    const base: TargetOverrides = {
      host: "board.local",
      username: "root",
      credentialRef: "board",
      proxyChain: [
        { host: "jump.local", port: 22, username: "jump", credentialRef: "", hostKey: "" },
      ],
    };
    expect(codeOf(() => resolveProfile({}, base))).toBe("config.invalid");
    const pinned: TargetOverrides = {
      ...base,
      proxyChain: [
        {
          host: "jump.local",
          port: 22,
          username: "jump",
          credentialRef: "jump-key",
          hostKey: PIN,
        },
      ],
    };
    expect(resolveProfile({}, pinned).proxyChain).toHaveLength(1);
  });
});
