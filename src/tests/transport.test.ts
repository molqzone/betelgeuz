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
      "printf 'betelgeuz-pid\\t%s\\n' \"$$\" && cd '/opt' && MODE='it'\\''s a test' exec '/opt/my app' '--name=bob'\\''s'"
    );
    expect(request.allocatePty).toBe(false);
  });

  it("reports the run's pid as the first stdout line of every launch", () => {
    // `$$` survives `exec`, so the marker names the program's own pid — the
    // process identity the core reconciles after a dropped channel.
    const request = ExecRequest.launch(launchRequest({ executable: "/opt/app" }));
    expect(
      request.command.startsWith("printf 'betelgeuz-pid\\t%s\\n' \"$$\" && ")
    ).toBe(true);
    expect(request.command.endsWith("exec '/opt/app'")).toBe(true);
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
      kind: "preflightDestination",
      directory: "/opt/app; rm -rf /",
    });
    expect(request.command).toContain("test -d '/opt/app; rm -rf /'");
    expect(request.command).toContain("df -Pk '/opt/app; rm -rf /'");
    expect(request.allocatePty).toBe(false);
    expect(
      codeOf(() =>
        ExecRequest.fixed({ kind: "preflightDestination", directory: "bad\0" })
      )
    ).toBe("config.invalid");
  });

  it("creates a destination directory without interpolating it", () => {
    const request = ExecRequest.fixed({
      kind: "makeDirectory",
      directory: "/opt/app; rm -rf /",
    });
    expect(request.command).toBe("mkdir -p -- '/opt/app; rm -rf /'");
    expect(
      codeOf(() => ExecRequest.fixed({ kind: "makeDirectory", directory: "bad\0" }))
    ).toBe("config.invalid");
  });

  it("probes and signals only validated process identities", () => {
    expect(ExecRequest.fixed({ kind: "probeProcess", pid: 1234 }).command).toBe(
      "if kill -0 1234 2>/dev/null; then printf 'alive'; else printf 'gone'; fi"
    );
    expect(
      ExecRequest.fixed({ kind: "signalProcessGroup", pid: 1234, signal: "TERM" })
        .command
    ).toBe("kill -s TERM -- -1234");
    expect(codeOf(() => ExecRequest.fixed({ kind: "probeProcess", pid: -1 }))).toBe(
      "config.invalid"
    );
    expect(
      codeOf(() => ExecRequest.fixed({ kind: "probeProcess", pid: 1.5 }))
    ).toBe("config.invalid");
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
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- template coercion is the behavior under test
    expect(`${secret}`).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toContain("[REDACTED]");
    expect(secret.expose()).toBe("hunter2");
    secret.wipe();
    expect(secret.expose()).toBe("");
  });
});
