/**
 * Configuration records — the shapes of VS Code settings and strategy
 * configuration as they appear in JSON. These are serialized boundaries and
 * are pinned by snapshot tests.
 *
 * TODO(profile step): the settings key constants (`betelgeuz.*`) live here too.
 */

/** A secret in a settings/credential record. At the credential boundary this
 * is wrapped by the secret type (code discipline S3); the alias documents the
 * at-rest shape. */
export type SensitiveString = string;

export type CredentialMaterial = {
  passphrase?: SensitiveString | null;
  password?: SensitiveString | null;
};

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
