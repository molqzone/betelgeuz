/**
 * Error catalog — the single source of truth for error semantics.
 *
 * Core modules fail with `BetelgeuzError` values and never with free-form
 * user-facing text; the UI maps the catalog code to a uniform message and one
 * remediation action. `docs/ERRORS.md` is generated from this catalog and the
 * strategy-owned catalogs (`npm run gen:errors`) and is never hand-edited.
 *
 * This module owns the common core codes and the error type. Each strategy
 * owns the definitions for its namespaced codes (plan §6: `rproc.*` lives in
 * `src/strategies/remoteproc.ts`) and constructs them through its own factory,
 * which passes the definition in — the common catalog never needs to know a
 * strategy's namespace, so the dependency stays one-way.
 */
import type { RemoteprocErrorCode } from "./strategies/remoteproc";

export type Phase =
  | "profile"
  | "config"
  | "connect"
  | "identity"
  | "inspect"
  | "artifact"
  | "deploy"
  | "lifecycle"
  | "debug";

/** Catalog metadata: `any` marks codes that can occur in every phase. */
export type CatalogPhase = Phase | "any";

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
  | "upgradeTargetSftpServer"
  | "installCmakeTools"
  | "installGdbserver"
  | "inspectTrace"
  | "showLog";

export interface ErrorDef {
  readonly phase: CatalogPhase;
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
  "identity.descriptor-timeout": {
    phase: "identity",
    retriable: true,
    remediation: "retry",
    summary: "Reading the hardware descriptor from the target timed out.",
  },
  "identity.descriptor-unreadable": {
    phase: "identity",
    retriable: false,
    remediation: "showLog",
    summary: "The target returned a hardware descriptor that could not be read.",
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
  "artifact.runtime-incompatible": {
    phase: "artifact",
    retriable: false,
    remediation: "checkArtifactToolchain",
    summary: "The artifact's ELF runtime requirements do not match the target.",
  },
  "artifact.runtime-probe-failed": {
    phase: "artifact",
    retriable: true,
    remediation: "retry",
    summary: "Reading the target runtime information for deployment failed.",
  },
  "artifact.cmake-unavailable": {
    phase: "artifact",
    retriable: false,
    remediation: "installCmakeTools",
    summary: "CMake Tools is not available to resolve the workspace's artifact.",
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
  "operation.cancelled": {
    phase: "any",
    retriable: false,
    remediation: "none",
    summary: "The operation was cancelled before it completed.",
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
  "deploy.activation-unsupported": {
    phase: "deploy",
    retriable: false,
    remediation: "upgradeTargetSftpServer",
    summary:
      "The target's SFTP server cannot replace an existing file atomically, so activation is refused.",
  },
  "deploy.preflight-failed": {
    phase: "deploy",
    retriable: false,
    remediation: "checkPrivileges",
    summary:
      "The target destination failed deployment preflight (storage, mount, or permissions).",
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
  "runtime.service-manager-missing": {
    phase: "lifecycle",
    retriable: false,
    remediation: "selectSupportedStrategy",
    summary: "The configured service mode has no supported service manager or unit.",
  },
  "runtime.orphan-risk": {
    phase: "lifecycle",
    retriable: false,
    remediation: "selectSupportedStrategy",
    summary: "The foreground process cannot be proven safe to clean up after disconnect.",
  },
  "internal.unexpected": {
    phase: "any",
    retriable: false,
    remediation: "showLog",
    summary:
      "An unexpected failure occurred; carries the failed phase and the underlying cause.",
  },
} as const satisfies Record<string, ErrorDef>;

export type ErrorCode = keyof typeof COMMON_ERRORS | RemoteprocErrorCode;

/** The definition of a common core code. Strategy-owned codes resolve from
 *  their own catalog, passed to the constructor by the owning strategy's
 *  factory — an unknown code here is a programmer error, never a fallback. */
export function errorDef(code: ErrorCode): ErrorDef {
  const def = COMMON_ERRORS[code as keyof typeof COMMON_ERRORS];
  if (def === undefined) {
    throw new Error(`invariant violated: ${code} has no common error definition`);
  }
  return def;
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
  /** The definition of a strategy-owned code, supplied by the owning
   *  strategy's factory so the common catalog never learns strategy
   *  namespaces. Common codes resolve from this module's own catalog. */
  definition?: ErrorDef;
}

/** A structured failure. The UI renders from `code`; the rest is context. */
export class BetelgeuzError extends Error {
  readonly code: ErrorCode;
  readonly phase: Phase;
  readonly retriable: boolean;
  readonly remediation: RemediationId;
  /** The catalog summary, carried by the instance so renderers never need a
   *  catalog lookup — a strategy code renders from its own definition. */
  readonly summary: string;
  readonly targetState?: string;
  readonly detail?: string;
  readonly causeText?: string;

  constructor(code: ErrorCode, context: BetelgeuzErrorContext = {}) {
    const def = context.definition ?? errorDef(code);
    const detail = context.detail ? ` [${context.detail}]` : "";
    super(`betelgeuz.${code}: ${def.summary}${detail}`);
    this.name = "BetelgeuzError";
    this.code = code;
    // `any` is catalog metadata, never an instance state: codes that can occur
    // in every phase must carry the concrete phase they occurred in.
    const phase = context.phase ?? (def.phase === "any" ? undefined : def.phase);
    if (phase === undefined) {
      throw new Error(`invariant violated: ${code} requires an explicit phase`);
    }
    this.phase = phase;
    this.retriable = def.retriable;
    this.remediation = def.remediation;
    this.summary = def.summary;
    this.targetState = context.targetState;
    this.detail = context.detail;
    this.causeText = context.cause === undefined ? undefined : describeCause(context.cause);
  }

  /** Collapses an unexpected failure while keeping the phase it happened in. */
  static wrapUnexpected(phase: Phase, cause: unknown, detail?: string): BetelgeuzError {
    return new BetelgeuzError("internal.unexpected", { phase, cause, detail });
  }
}

export function isBetelgeuzError(value: unknown): value is BetelgeuzError {
  return value instanceof BetelgeuzError;
}

/** Renders an unknown cause into something worth reading in a log. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  try {
    return JSON.stringify(cause) ?? "unknown error";
  } catch {
    return "unserializable error";
  }
}

/** Renders the `docs/ERRORS.md` body from the common catalog plus each
 *  strategy's own catalog, in registry order. */
export function renderErrorCatalog(
  ...strategyCatalogs: Array<Record<string, ErrorDef>>
): string {
  const blocks: Array<[string, ErrorDef]> = [
    ...Object.entries(COMMON_ERRORS),
    ...strategyCatalogs.flatMap((catalog) => Object.entries(catalog)),
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
