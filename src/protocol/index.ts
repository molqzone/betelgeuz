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
export type { HardwareDescriptor } from "./descriptor";

import type { CredentialSecrets, ProfileCatalog, TargetOverrides } from "./config";
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

/** The already-built artifact handed to the deploy pipeline. */
export type ArtifactRecord = {
  configuration?: string | null;
  contentHash: string;
  path: string;
  size: number;
  symbolsPath?: string | null;
  targetName: string;
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

export type OperationResult = {
  operationId: string;
};

export type LogsParams = {
  attachId: string;
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
