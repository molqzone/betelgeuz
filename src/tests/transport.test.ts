import { describe, expect, it } from "vitest";

import { BetelgeuzError } from "../errors";
import { Secret } from "../secret";
import {
  ExecRequest,
  HostKeyFingerprint,
  type LaunchRequest,
} from "../transport";

const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function launchRequest(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    executable: "fixed-launcher",
    argv: [],
    environment: {},
    allocatePty: false,
    ...overrides,
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

describe("ExecRequest", () => {
  it("renders encoded arguments and environment", () => {
    const request = ExecRequest.launch(
      launchRequest({
        executable: "/opt/my app",
        argv: ["--name=bob's"],
        cwd: "/opt",
        environment: { MODE: new Secret("it's a test") },
      })
    );
    expect(request.command).toBe(
      "cd '/opt' && MODE='it'\\''s a test' exec '/opt/my app' '--name=bob'\\''s'"
    );
    expect(request.allocatePty).toBe(false);
  });

  it("rejects NUL bytes and non-identifier environment names", () => {
    expect(codeOf(() => ExecRequest.launch(launchRequest({ executable: "bad\0" })))).toBe(
      "config.invalid"
    );
    expect(
      codeOf(() =>
        ExecRequest.launch(
          launchRequest({ environment: { "BAD-NAME": new Secret("v") } })
        )
      )
    ).toBe("config.invalid");
  });

  it("encodes fixed templates from typed values only", () => {
    const request = ExecRequest.fixed({
      kind: "signalProcessGroup",
      pgid: 4242,
      signal: "term",
    });
    expect(request.command).toBe("kill -TERM -- -4242");
  });
});

describe("HostKeyFingerprint", () => {
  it("accepts OpenSSH display form and rejects everything else", () => {
    expect(HostKeyFingerprint.parse(PIN).asString()).toBe(PIN);
    expect(codeOf(() => HostKeyFingerprint.parse("md5:abc"))).toBe("config.invalid");
    expect(codeOf(() => HostKeyFingerprint.parse("SHA256:short"))).toBe("config.invalid");
  });
});

describe("Secret", () => {
  it("is redacted in every stringification", () => {
    const secret = new Secret("hunter2");
    expect(`${secret}`).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toContain("[REDACTED]");
    expect(secret.expose()).toBe("hunter2");
    secret.wipe();
    expect(secret.expose()).toBe("");
  });
});
