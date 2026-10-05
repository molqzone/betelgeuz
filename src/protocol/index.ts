/**
 * Service vocabulary — the typed request/result shapes of the core service
 * layer. This was the wire contract before the pivot to a single process; the
 * RPC machinery (method names, handshake, envelopes, progress tokens) is gone.
 * Cancellation is an AbortSignal, events are typed callbacks, and errors are
 * `BetelgeuzError` values (see `src/errors`).
 */
export type {
  CredentialMaterial,
  CredentialSecrets,
  LinuxRemoteprocConfiguration,
  ProfileCatalog,
  ProxyHopProfile,
  SensitiveString,
  TargetOverrides,
  TargetProfile,
} from "./config";
export {
  ATTACH_PREFIX,
  ATTACH_STRATEGY_KEY,
  CONFIG_KEY_PATTERNS,
  DEPLOY_ARGS_KEY,
  DEPLOY_ARTIFACT_KEY,
  DEPLOY_ARTIFACT_PATH_KEY,
  DEPLOY_CWD_KEY,
  DEPLOY_ENVIRONMENT_KEY,
  DEPLOY_EXECUTABLE_KEY,
  DEPLOY_FILE_MODE_KEY,
  DEPLOY_LOCAL_TARGET_KEY,
  DEPLOY_REMOTE_PATH_KEY,
  DEPLOY_SOURCE_KEY,
  DEPLOY_SOURCES,
  DEPLOY_RUN_MODE_KEY,
  DEPLOY_SERVICE_UNIT_KEY,
  FIXED_CONFIG_KEYS,
  PROFILES_KEY,
  TARGET_INLINE_PREFIX,
  TARGET_PROFILE_KEY,
  resolveArtifactPath,
  strategyKey,
} from "./config";
export type { HardwareDescriptor } from "./descriptor";

import type {
  CredentialSecrets,
  DeploySource,
  ProfileCatalog,
  TargetOverrides,
} from "./config";
export type { DeploySource };
import type { HardwareDescriptor } from "./descriptor";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "attached"
  | "reconnecting";

export type TargetOperation =
  | "deploy"
  | "start"
  | "stop"
  | "restart"
  | "restorePrevious"
  | "logs"
  | "debugPrepare";

export type OutputStream = "stdout" | "stderr";

/** Receives streamed target output while an operation runs. */
export type OutputListener = (chunk: OutputChunk) => void;

/** The already-built artifact handed to the deploy pipeline. */
export type ArtifactRecord = {
  configuration?: string | null;
  contentHash: string;
  path: string;
  size: number;
  symbolsPath?: string | null;
  targetName: string;
};

/** Phase 1 userspace application strategy settings. */
export type ApplicationConfiguration = {
  args?: Array<string>;
  cwd?: string;
  environment?: Record<string, string>;
  executable?: string;
  fileMode?: string | number;
  remotePath: string;
  runMode?: "foreground" | "service";
  serviceUnit?: string;
  stopGraceMs?: number;
};

/** How a run the strategy owns ended: an exit status, a terminating signal,
 *  or neither — an outcome with no fields is an end whose details the strategy
 *  did not observe, reported as exactly that rather than guessed. */
export type RunOutcome = {
  signal?: string;
  status?: number;
};

/**
 * Strategy-reported target state. `state` is strategy-owned vocabulary — the
 * foreground application strategy reports `exited`/`running`/`stopped`, the
 * small-core strategy reports the remoteproc lifecycle — rendered as-is by
 * the surface. `outcome` and `detail` are optional strategy detail: the
 * process outcome for a foreground run, or the selected firmware.
 */
export type StatusResult = {
  detail?: string;
  outcome?: RunOutcome;
  state: string;
};

/** Fully resolved, validated connection settings. */
export type ResolvedProfile = {
  boardId?: string | null;
  deviceId?: string | null;
  host: string;
  hostKeyPinned: boolean;
  keepaliveSeconds: number;
  port: number;
  profileName?: string | null;
  proxyHops: number;
  socId?: string | null;
  username: string;
};

export type ResolveProfileParams = {
  catalog: ProfileCatalog;
  target: TargetOverrides;
};

export type ResolveProfileResult = {
  profile: ResolvedProfile;
};

export type InspectHostKeyParams = {
  catalog: ProfileCatalog;
  target: TargetOverrides;
};

export type InspectHostKeyResult = {
  hostKeyFingerprint: string;
};

/** The verified identity cached with the attach. */
export type VerifiedTargetIdentity = {
  descriptor: HardwareDescriptor;
  host: string;
  hostKeyFingerprint: string;
  port: number;
};

export type AttachRequest = {
  catalog: ProfileCatalog;
  credentialSecrets?: CredentialSecrets | null;
  strategyConfiguration?: unknown;
  strategyId: string;
  target: TargetOverrides;
};

export type AttachResult = {
  attachId: string;
  identity: VerifiedTargetIdentity;
  operations: Array<TargetOperation>;
  profile: ResolvedProfile;
  state: ConnectionState;
  strategyId: string;
};

export type AttachRef = {
  attachId: string;
};

/** Re-establishes the session of an existing attach after a drop. Carries the
 *  same one-use credential flow as `AttachRequest`; the attach's strategy is
 *  kept, so no `strategyId` is accepted here. */
export type ReconnectRequest = AttachRef & {
  catalog: ProfileCatalog;
  credentialSecrets?: CredentialSecrets | null;
  target: TargetOverrides;
};

export type DisconnectResult = {
  state: ConnectionState;
};

export type ArtifactHandoffParams = {
  artifact: ArtifactRecord;
  attachId: string;
};

export type ArtifactHandoffResult = {
  accepted: boolean;
};

/**
 * Deploys the artifact through the workspace's active strategy.
 * `configuration` is the strategy-owned settings shape, validated inside the
 * strategy itself (`unknown` at this boundary: the core never assumes which
 * strategy is bound). `stopRunningTarget` carries the user's explicit
 * confirmation for a strategy whose deployment stops a running target — plan
 * §6: stopping target work always requires explicit user action.
 */
export type DeployRequest = {
  artifact: ArtifactRecord;
  attachId: string;
  configuration: unknown;
  stopRunningTarget?: boolean;
};

export type DeployResult = {
  operationId: string;
  remotePath: string;
  previousSize?: number;
};

export type StartRequest = {
  attachId: string;
  configuration: unknown;
};

export type StopRequest = {
  attachId: string;
  configuration: unknown;
  graceMs?: number;
};

export type RestartRequest = StartRequest;

/** Re-selects the retained previous firmware version and starts the core;
 *  strategies that retain nothing report the operation unavailable. */
export type RestorePreviousRequest = {
  attachId: string;
  configuration: unknown;
};

/**
 * Probes the bound strategy's target interface after attach. Separated from
 * `attach` so an incompatibility is reported without discarding the attach
 * (plan §3, Phase 5): the binding survives and the user can switch strategy.
 */
export type ValidateStrategyRequest = {
  attachId: string;
  configuration: unknown;
};

export type ValidateStrategyResult = {
  strategyId: string;
};

export type StatusRequest = {
  attachId: string;
  configuration: unknown;
};

export type OperationResult = {
  operationId: string;
};

export type LogsParams = {
  attachId: string;
  configuration: unknown;
  cursor?: string | null;
  maxBytes?: number;
};

export type OutputChunk = {
  bytes: Array<number>;
  stream: OutputStream;
};

export type LogsResult = {
  chunks: Array<OutputChunk>;
  nextCursor?: string | null;
};

export type InspectResult = {
  identity?: VerifiedTargetIdentity | null;
  operations: Array<TargetOperation>;
  state: ConnectionState;
  targetState?: string | null;
};

export type DebugPrepareResult = {
  host: string;
  port: number;
  program?: string | null;
  providerId: string;
  symbolsPath?: string | null;
};
