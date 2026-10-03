/**
 * Configuration records — the shapes of VS Code settings and strategy
 * configuration as they appear in JSON. These are serialized boundaries and
 * are pinned by snapshot tests.
 *
 * The settings key constants (`betelgeuz.*`) live here so the frontend and
 * core do not grow separate lists of configuration names.
 */

/** A secret in a settings/credential record. At the credential boundary this
 * is wrapped by the secret type (code discipline S3); the alias documents the
 * at-rest shape. */
export type SensitiveString = string;

export type CredentialMaterial = {
  passphrase?: SensitiveString | null;
  password?: SensitiveString | null;
  privateKey?: SensitiveString | null;
};

import { isAbsolute, join } from "node:path";

/** One-use credential material indexed by the profile credential reference. */
export type CredentialSecrets = Record<string, CredentialMaterial>;

/** One configured jump host. Arbitrary proxy commands are not accepted. */
export type ProxyHopProfile = {
  credentialRef: string;
  host: string;
  hostKey: string;
  port?: number;
  username: string;
};

/** Target connection settings and board identity pins. Secret material stays
 * in protected storage; `credentialRef` is only a lookup key. */
export type TargetProfile = {
  boardId?: string | null;
  credentialRef: string;
  deviceId?: string | null;
  host: string;
  hostKey?: string | null;
  keepaliveSeconds?: number;
  port?: number;
  proxyChain?: Array<ProxyHopProfile>;
  socId?: string | null;
  username: string;
};

/** User-level named profiles keyed by the name selected in a workspace. */
export type ProfileCatalog = Record<string, TargetProfile>;

/** Workspace-scoped values that override a named profile when populated. */
export type TargetOverrides = {
  boardId?: string | null;
  credentialRef?: string | null;
  deviceId?: string | null;
  host?: string | null;
  hostKey?: string | null;
  keepaliveSeconds?: number | null;
  port?: number | null;
  profile?: string | null;
  proxyChain?: Array<ProxyHopProfile> | null;
  socId?: string | null;
  username?: string | null;
};

/** The `linux.remoteproc` strategy's settings. */
export type LinuxRemoteprocConfiguration = {
  firmwarePath: string;
  instance: string;
};

/** The user-level named target profiles. */
export const PROFILES_KEY = "betelgeuz.profiles";

/** Names a user-level profile selected by the workspace. */
export const TARGET_PROFILE_KEY = "betelgeuz.target.profile";

/** Prefix shared by inline target overrides. */
export const TARGET_INLINE_PREFIX = "betelgeuz.target.";

/** The deploy strategy selected by the workspace. */
export const ATTACH_STRATEGY_KEY = "betelgeuz.attach.strategy";

/** Prefix shared by attach and per-strategy configuration keys. */
export const ATTACH_PREFIX = "betelgeuz.attach.";

/** Builds a per-strategy key using the complete strategy ID. */
export function strategyKey(strategyId: string, name: string): string {
  return `${ATTACH_PREFIX}${strategyId}.${name}`;
}

/** The CMake target whose already-built artifact is consumed. */
export const DEPLOY_LOCAL_TARGET_KEY = "betelgeuz.deploy.localTarget";

/** Optional suffix or pattern for selecting one artifact in a later phase. */
export const DEPLOY_ARTIFACT_KEY = "betelgeuz.deploy.artifact";

/** Where the artifact comes from: CMake Tools (Phase 2) or the manual path. */
export const DEPLOY_SOURCE_KEY = "betelgeuz.deploy.source";

export const DEPLOY_SOURCES = ["cmake", "manual"] as const;
export type DeploySource = (typeof DEPLOY_SOURCES)[number];

/** Phase 1 manual artifact path; CMake Tools owns this handoff later. */
export const DEPLOY_ARTIFACT_PATH_KEY = "betelgeuz.deploy.artifactPath";

/**
 * A configured artifact path is workspace-relative unless it is absolute, and
 * the extension host's working directory is neither the workspace nor the
 * workspace folder — so resolve it against the folder explicitly.
 */
export function resolveArtifactPath(folderPath: string, configured: string): string {
  return isAbsolute(configured) ? configured : join(folderPath, configured);
}

/** Remote destination for the selected artifact. */
export const DEPLOY_REMOTE_PATH_KEY = "betelgeuz.deploy.remotePath";

/** Structured foreground launch settings. */
export const DEPLOY_EXECUTABLE_KEY = "betelgeuz.deploy.executable";
export const DEPLOY_ARGS_KEY = "betelgeuz.deploy.args";
export const DEPLOY_CWD_KEY = "betelgeuz.deploy.cwd";
export const DEPLOY_ENVIRONMENT_KEY = "betelgeuz.deploy.environment";
export const DEPLOY_FILE_MODE_KEY = "betelgeuz.deploy.fileMode";

export const DEPLOY_RUN_MODE_KEY = "betelgeuz.deploy.runMode";

/** A pre-provisioned target service unit. */
export const DEPLOY_SERVICE_UNIT_KEY = "betelgeuz.deploy.serviceUnit";

/** Every fixed configuration key, in documentation order. */
export const FIXED_CONFIG_KEYS = [
  PROFILES_KEY,
  TARGET_PROFILE_KEY,
  `${TARGET_INLINE_PREFIX}host`,
  `${TARGET_INLINE_PREFIX}port`,
  `${TARGET_INLINE_PREFIX}username`,
  `${TARGET_INLINE_PREFIX}credentialRef`,
  `${TARGET_INLINE_PREFIX}hostKey`,
  `${TARGET_INLINE_PREFIX}deviceId`,
  `${TARGET_INLINE_PREFIX}boardId`,
  `${TARGET_INLINE_PREFIX}socId`,
  `${TARGET_INLINE_PREFIX}keepaliveSeconds`,
  `${TARGET_INLINE_PREFIX}proxyChain`,
  ATTACH_STRATEGY_KEY,
  DEPLOY_LOCAL_TARGET_KEY,
  DEPLOY_ARTIFACT_PATH_KEY,
  DEPLOY_ARTIFACT_KEY,
  DEPLOY_SOURCE_KEY,
  DEPLOY_REMOTE_PATH_KEY,
  DEPLOY_EXECUTABLE_KEY,
  DEPLOY_ARGS_KEY,
  DEPLOY_CWD_KEY,
  DEPLOY_ENVIRONMENT_KEY,
  DEPLOY_FILE_MODE_KEY,
  DEPLOY_RUN_MODE_KEY,
  DEPLOY_SERVICE_UNIT_KEY,
] as const;

/** Prefixes for pattern-generated inline and strategy-specific keys. */
export const CONFIG_KEY_PATTERNS = [TARGET_INLINE_PREFIX, ATTACH_PREFIX] as const;
