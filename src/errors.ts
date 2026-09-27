/**
 * Error catalog — the single source of truth for error semantics.
 *
 * Core modules fail with `BetelgeuzError` values and never with free-form
 * user-facing text; the UI maps the catalog code to a uniform message and one
 * remediation action. `docs/ERRORS.md` is generated from this catalog
 * (`npm run gen:errors`) and is never hand-edited.
 *
 * Strategy-owned codes (`rproc.*`) live in their own block: by plan each
 * strategy owns its namespaced definitions. TODO(Phase 3): they move into the
 * strategy module when it lands.
 */

export type Phase =
  | "profile"
  | "config"
  | "connect"
  | "identity"
  | "inspect"
  | "artifact"
  | "deploy"
  | "lifecycle"
  | "debug"
  | "any";

export type RemediationId =
  | "upgradeFrontend"
  | "checkProfileSettings"
  | "fixProxySettings"
  | "openSettings"
  | "checkNetworkAndSshService"
  | "checkCredentials"
  | "checkAlgorithms"
  | "checkHostKeyPin"
  | "retry"
  | "checkIdentityPins"
  | "rebindAttach"
  | "buildWithCMakeTools"
  | "checkArtifactToolchain"
  | "deploySingleArtifact"
  | "selectSupportedStrategy"
  | "retryLater"
  | "none"
  | "restorePreviousVersion"
  | "checkPrivileges"
  | "installGdbserver"
  | "inspectTrace"
  | "showLog";

export interface ErrorDef {
  readonly phase: Phase;
  readonly retriable: boolean;
  readonly remediation: RemediationId;
  readonly summary: string;
}

export const COMMON_ERRORS = {
  "protocol.mismatch": {
    phase: "config",
    retriable: false,
    remediation: "upgradeFrontend",
    summary: "The frontend and core speak incompatible protocol versions.",
  },
  "profile.unresolved": {
    phase: "profile",
    retriable: false,
    remediation: "checkProfileSettings",
    summary: "The target profile was not found or is incomplete.",
  },
  "profile.unsupported-proxy": {
    phase: "profile",
    retriable: false,
    remediation: "fixProxySettings",
    summary: "The profile uses a proxy form the transport cannot express.",
  },
  "config.invalid": {
    phase: "config",
    retriable: false,
    remediation: "openSettings",
    summary: "A betelgeuz setting has an invalid value.",
  },
  "ssh.unreachable": {
    phase: "connect",
    retriable: true,
    remediation: "checkNetworkAndSshService",
    summary:
      "The SSH endpoint could not be reached (timeout, refused, or unresolvable).",
  },
  "ssh.auth-failed": {
    phase: "connect",
    retriable: false,
    remediation: "checkCredentials",
    summary: "SSH authentication failed for the configured user.",
  },
  "ssh.handshake-failed": {
    phase: "connect",
    retriable: false,
    remediation: "checkAlgorithms",
    summary:
      "The SSH handshake failed before authentication (key exchange or key format).",
  },
  "ssh.hostkey-mismatch": {
    phase: "identity",
    retriable: false,
    remediation: "checkHostKeyPin",
    summary:
      "The presented SSH host key does not match the pinned or recorded key.",
  },
  "ssh.lost": {
    phase: "connect",
    retriable: true,
    remediation: "retry",
    summary: "An established SSH connection dropped during an operation.",
  },
  "identity.descriptor-mismatch": {
    phase: "identity",
    retriable: false,
    remediation: "checkIdentityPins",
    summary: "The hardware descriptor does not match the pinned board identity.",
  },
  "identity.instance-changed": {
    phase: "identity",
    retriable: false,
    remediation: "rebindAttach",
    summary:
      "The backend instance identity changed since the attach was created.",
  },
  "artifact.missing": {
    phase: "artifact",
    retriable: false,
    remediation: "buildWithCMakeTools",
    summary: "No existing artifact was found for the selected CMake target.",
  },
  "artifact.arch-mismatch": {
    phase: "artifact",
    retriable: false,
    remediation: "checkArtifactToolchain",
    summary: "Host-side artifact validation failed (format or architecture).",
  },
  "artifact.ambiguous": {
    phase: "artifact",
    retriable: false,
    remediation: "deploySingleArtifact",
    summary:
      "The target produces multiple artifacts; the single-artifact rule applies in the MVP.",
  },
  "strategy.unsupported-target": {
    phase: "inspect",
    retriable: false,
    remediation: "selectSupportedStrategy",
    summary:
      "The selected strategy's required target interface is unavailable.",
  },
  "deploy.busy": {
    phase: "deploy",
    retriable: true,
    remediation: "retryLater",
    summary: "Another mutating operation is running on this attach.",
  },
  "deploy.cancelled": {
    phase: "deploy",
    retriable: false,
    remediation: "none",
    summary:
      "The operation was cancelled before its commit point; the target is unchanged.",
  },
  "deploy.upload-failed": {
    phase: "deploy",
    retriable: true,
    remediation: "retry",
    summary: "Upload to the staging location failed; nothing was activated.",
  },
  "deploy.commit-failed": {
    phase: "deploy",
    retriable: false,
    remediation: "restorePreviousVersion",
    summary:
      "Activating the staged artifact failed; carries the target state at the abort point.",
  },
  "privilege.denied": {
    phase: "deploy",
    retriable: false,
    remediation: "checkPrivileges",
    summary:
      "The target account lacks the privilege required by a templated command.",
  },
  "debug.gdbserver-missing": {
    phase: "debug",
    retriable: false,
    remediation: "installGdbserver",
    summary: "gdbserver is not available on the target for the debug session.",
  },
  "internal.unexpected": {
    phase: "any",
    retriable: false,
    remediation: "showLog",
    summary:
      "An unexpected failure occurred; carries the failed phase and the underlying cause.",
  },
} as const satisfies Record<string, ErrorDef>;

/** Strategy-owned codes; TODO(Phase 3): move into the strategy module. */
export const STRATEGY_ERRORS = {
  "rproc.instance-missing": {
    phase: "lifecycle",
    retriable: false,
    remediation: "selectSupportedStrategy",
    summary:
      "The board exposes no supported small-core control interface for the configured core.",
  },
  "rproc.stop-failed": {
    phase: "lifecycle",
    retriable: true,
    remediation: "retry",
    summary: "Stopping the small core failed; the deployed firmware is untouched.",
  },
  "rproc.crashed": {
    phase: "lifecycle",
    retriable: false,
    remediation: "restorePreviousVersion",
    summary:
      "The small core entered the crashed state; carries the kernel log tail when readable.",
  },
  "rproc.state-timeout": {
    phase: "lifecycle",
    retriable: true,
    remediation: "inspectTrace",
    summary:
      "Timed out waiting for the core state transition; carries the last observed state.",
  },
} as const satisfies Record<string, ErrorDef>;

export type ErrorCode = keyof typeof COMMON_ERRORS | keyof typeof STRATEGY_ERRORS;

export const ERROR_CATALOG: Record<ErrorCode, ErrorDef> = {
  ...COMMON_ERRORS,
  ...STRATEGY_ERRORS,
};

export function errorDef(code: ErrorCode): ErrorDef {
  return ERROR_CATALOG[code];
}

export interface BetelgeuzErrorContext {
  /** The underlying failure, stringified; logged, never shown raw. */
  cause?: unknown;
  /** Target state at the abort point, e.g. the small core's state. */
  targetState?: string;
  /** Machine-oriented extra detail (paths, instance names), not user prose. */
  detail?: string;
  /** Overrides the catalog phase; used by `internal.unexpected`. */
  phase?: Phase;
}

/** A structured failure. The UI renders from `code`; the rest is context. */
export class BetelgeuzError extends Error {
  readonly code: ErrorCode;
  readonly phase: Phase;
  readonly retriable: boolean;
  readonly remediation: RemediationId;
  readonly targetState?: string;
  readonly detail?: string;
  readonly causeText?: string;

  constructor(code: ErrorCode, context: BetelgeuzErrorContext = {}) {
    const def = errorDef(code);
    const detail = context.detail ? ` [${context.detail}]` : "";
    super(`betelgeuz.${code}: ${def.summary}${detail}`);
    this.name = "BetelgeuzError";
    this.code = code;
    this.phase = context.phase ?? def.phase;
    this.retriable = def.retriable;
    this.remediation = def.remediation;
    this.targetState = context.targetState;
    this.detail = context.detail;
    this.causeText =
      context.cause === undefined ? undefined : String(context.cause);
  }

  /** Collapses an unexpected failure while keeping the phase it happened in. */
  static wrapUnexpected(phase: Phase, cause: unknown, detail?: string): BetelgeuzError {
    return new BetelgeuzError("internal.unexpected", { phase, cause, detail });
  }
}

export function isBetelgeuzError(value: unknown): value is BetelgeuzError {
  return value instanceof BetelgeuzError;
}

/** Renders the `docs/ERRORS.md` body from the catalog. */
export function renderErrorCatalog(): string {
  const blocks: Array<[string, ErrorDef]> = [
    ...Object.entries(COMMON_ERRORS),
    ...Object.entries(STRATEGY_ERRORS),
  ];
  let out = "# Error catalog\n\n";
  out +=
    "Generated by `npm run gen:errors` from core and strategy error definitions. Do not edit by hand. Remediation values are stable action identifiers for frontend presentation.\n\n";
  out += "| code | phase | meaning | remediation action | retriable |\n";
  out += "| --- | --- | --- | --- | --- |\n";
  for (const [code, def] of blocks) {
    const retriable = def.retriable ? "yes" : "no";
    out += `| \`${code}\` | ${def.phase} | ${def.summary} | \`${def.remediation}\` | ${retriable} |\n`;
  }
  return out;
}
