import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BetelgeuzError,
  COMMON_ERRORS,
  ERROR_CATALOG,
  STRATEGY_ERRORS,
  isBetelgeuzError,
  renderErrorCatalog,
} from "../errors";

describe("error catalog", () => {
  it("every code is namespaced and its metadata is complete", () => {
    for (const [code, def] of Object.entries(ERROR_CATALOG)) {
      expect(code).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
      expect(def.summary.length).toBeGreaterThan(0);
      expect(def.remediation.length).toBeGreaterThan(0);
    }
  });

  it("docs/ERRORS.md matches the catalog", () => {
    const documented = readFileSync(
      join(process.cwd(), "docs", "ERRORS.md"),
      "utf8"
    );
    expect(documented).toBe(renderErrorCatalog());
  });
});

describe("BetelgeuzError", () => {
  it("carries the catalog definition", () => {
    const error = new BetelgeuzError("ssh.lost", { detail: "eof" });
    expect(error.code).toBe("ssh.lost");
    expect(error.phase).toBe("connect");
    expect(error.retriable).toBe(true);
    expect(error.remediation).toBe("retry");
    expect(error.detail).toBe("eof");
    expect(error.message).toContain("ssh.lost");
  });

  it("wrapUnexpected keeps the phase and the cause", () => {
    const error = BetelgeuzError.wrapUnexpected("deploy", new Error("boom"));
    expect(error.code).toBe("internal.unexpected");
    expect(error.phase).toBe("deploy");
    expect(error.causeText).toContain("boom");
  });

  it("every-phase codes require an explicit instance phase", () => {
    expect(() => new BetelgeuzError("internal.unexpected")).toThrow(
      /requires an explicit phase/
    );
  });

  it("cause text stays readable for non-error values", () => {
    const error = BetelgeuzError.wrapUnexpected("deploy", { code: 42 });
    expect(error.causeText).toContain('"code":42');
    expect(BetelgeuzError.wrapUnexpected("deploy", "plain").causeText).toBe(
      "plain"
    );
  });

  it("strategy codes stay namespaced and separate", () => {
    for (const code of Object.keys(STRATEGY_ERRORS)) {
      expect(code.startsWith("rproc.")).toBe(true);
    }
    expect(Object.keys(COMMON_ERRORS)).not.toContain("rproc.crashed");
  });

  it("is recognized by the type guard", () => {
    expect(isBetelgeuzError(new BetelgeuzError("config.invalid"))).toBe(true);
    expect(isBetelgeuzError(new Error("plain"))).toBe(false);
  });
});
