import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BetelgeuzError,
  COMMON_ERRORS,
  type ErrorDef,
  type RemediationId,
} from "../errors";
import { RPROC_ERRORS } from "../strategies/remoteproc";
import { remediationFor } from "../surface/remediation";

/** Commands this mapping may name: ours (contributed in package.json) and the
 *  VS Code commands the map uses, each verified present in a real workbench
 *  build. Anything else would render a button that does nothing. */
const VERIFIED_VSCODE_COMMANDS = [
  "workbench.action.openSettings",
  "workbench.view.extensions",
  "cmake.build",
];

function contributedCommands(): Array<string> {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    contributes: { commands: Array<{ command: string }> };
  };
  return manifest.contributes.commands.map(({ command }) => command);
}

/** Every code and its definition, including strategy-owned codes whose
 *  definitions arrive at construction rather than from the common catalog. */
function catalog(): Array<[string, ErrorDef]> {
  return [
    ...Object.entries(COMMON_ERRORS),
    ...Object.entries(RPROC_ERRORS),
  ];
}

function errorFor(code: string, def: ErrorDef): BetelgeuzError {
  return new BetelgeuzError(code as never, { definition: def, phase: "deploy" });
}

describe("remediation map", () => {
  it("names a concrete step for every action except the informational one", () => {
    for (const [code, def] of catalog()) {
      const remediation = remediationFor(errorFor(code, def));
      if (def.remediation === "none") {
        continue;
      }
      // The step is the advice, or the button that performs it, or a retry —
      // "Try Again" needs no caption.
      const stepped =
        remediation.advice !== "" ||
        remediation.button !== undefined ||
        remediation.retry === true;
      expect(stepped, code).toBe(true);
    }
  });

  it("offers a button only for commands that exist", () => {
    const contributed = contributedCommands();
    for (const [code, def] of catalog()) {
      const remediation = remediationFor(errorFor(code, def));
      const button = remediation.button;
      if (button === undefined) {
        continue;
      }
      expect(button.label.length, code).toBeGreaterThan(0);
      const known = button.command.startsWith("betelgeuz.")
        ? contributed.includes(button.command)
        : VERIFIED_VSCODE_COMMANDS.includes(button.command);
      expect(known, `${code} offers \`${button.command}\` which no one registers`).toBe(true);
    }
  });

  it("offers a retry exactly for the actions that mean retry", () => {
    const retrying = new Set<RemediationId>(["retry", "retryLater", "checkNetworkAndSshService"]);
    for (const [code, def] of catalog()) {
      const remediation = remediationFor(errorFor(code, def));
      expect(remediation.retry === true, code).toBe(retrying.has(def.remediation));
    }
  });

  it("opens the invalid setting at the key its detail names", () => {
    const error = new BetelgeuzError("config.invalid", {
      detail: "betelgeuz.deploy.fileMode must be an octal mode such as 0755",
    });
    expect(remediationFor(error).button?.args).toEqual(["betelgeuz.deploy.fileMode"]);
  });
});
