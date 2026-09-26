//! Configuration records and keys: the two-layer model of target profiles
//! (user-level, shared across workspaces) and attach configuration
//! (workspace-scoped).
//!
//! This module is the single source of the key list (`protocol::config`); the
//! plan documents the model, frontends generate their settings schema from
//! here. Implemented strategy keys use the full strategy ID as their prefix.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// One-use secret material supplied from frontend protected storage. It is
/// never persisted with the profile or echoed in protocol results.
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SensitiveString(String);

impl SensitiveString {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for SensitiveString {
    fn from(value: String) -> Self {
        SensitiveString(value)
    }
}

impl std::fmt::Debug for SensitiveString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

impl Drop for SensitiveString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// The secrets for one credential reference: an account password and/or the
/// passphrase of a private key.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialMaterial {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<SensitiveString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<SensitiveString>,
}

/// One-use values indexed by the profile credential reference. This allows a
/// target and each typed proxy hop to use different protected credentials.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct CredentialSecrets(pub BTreeMap<String, CredentialMaterial>);

/// One configured jump host. Every hop has its own credential reference and
/// pinned SSH host key; arbitrary proxy commands are not accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyHopProfile {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub credential_ref: String,
    pub host_key: String,
}

/// Target connection settings and board identity pins. Secret material stays
/// in protected credential storage; `credential_ref` is only a lookup key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetProfile {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub credential_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soc_id: Option<String>,
    #[serde(default = "default_keepalive_seconds")]
    pub keepalive_seconds: u16,
    #[serde(default)]
    pub proxy_chain: Vec<ProxyHopProfile>,
}

/// User-level named SSH profiles keyed by the name selected in a workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct ProfileCatalog {
    pub profiles: BTreeMap<String, TargetProfile>,
}

/// Workspace-scoped values that override a named profile when populated.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soc_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keepalive_seconds: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_chain: Option<Vec<ProxyHopProfile>>,
}

fn default_ssh_port() -> u16 {
    22
}

fn default_keepalive_seconds() -> u16 {
    30
}

/// The user-level named profiles setting.
pub const PROFILES: &str = "betelgeuz.profiles";
/// Names a user-level target profile (endpoint, credential reference, host-key
/// pin, identity pins). Identity pins live with the profile, never with the
/// workspace.
pub const TARGET_PROFILE: &str = "betelgeuz.target.profile";
/// Inline override for a profile field, e.g. `betelgeuz.target.host`.
pub const TARGET_INLINE_PREFIX: &str = "betelgeuz.target.";
/// The deploy strategy selected for this workspace, e.g. `linux.ssh-app`.
pub const ATTACH_STRATEGY: &str = "betelgeuz.attach.strategy";
/// Prefix shared by all attach configuration keys.
pub const ATTACH_PREFIX: &str = "betelgeuz.attach.";

/// Per-strategy keys use the full strategy ID as their prefix, e.g.
/// `betelgeuz.attach.linux.remoteproc.instance`.
pub fn strategy_key(strategy_id: &str, name: &str) -> String {
    format!("{ATTACH_PREFIX}{strategy_id}.{name}")
}

/// The CMake target whose already-built artifact is consumed. Never a build
/// invocation.
pub const DEPLOY_LOCAL_TARGET: &str = "betelgeuz.deploy.localTarget";
/// Multi-artifact disambiguation (suffix or pattern). Later-phase key; the MVP
/// deploys only targets with exactly one artifact.
pub const DEPLOY_ARTIFACT: &str = "betelgeuz.deploy.artifact";
/// Where the artifact is placed on the target (deployment destination).
pub const DEPLOY_REMOTE_PATH: &str = "betelgeuz.deploy.remotePath";
/// Structured run configuration: the runtime object and its arguments,
/// deliberately distinct from `remotePath` (the deployment destination).
pub const DEPLOY_EXECUTABLE: &str = "betelgeuz.deploy.executable";
pub const DEPLOY_ARGS: &str = "betelgeuz.deploy.args";
pub const DEPLOY_CWD: &str = "betelgeuz.deploy.cwd";
pub const DEPLOY_ENVIRONMENT: &str = "betelgeuz.deploy.environment";
pub const DEPLOY_FILE_MODE: &str = "betelgeuz.deploy.fileMode";
/// Legacy free-form command line; superseded by the structured run keys and
/// accepted only for compatibility.
pub const DEPLOY_RUN_COMMAND: &str = "betelgeuz.deploy.runCommand";
pub const DEPLOY_RUN_MODE: &str = "betelgeuz.deploy.runMode";
/// A unit provisioned on the target; Betelgeuz never generates unit files.
pub const DEPLOY_SERVICE_UNIT: &str = "betelgeuz.deploy.serviceUnit";

/// Every fixed (non-pattern) configuration key, in documentation order.
pub const FIXED_KEYS: &[&str] = &[
    PROFILES,
    TARGET_PROFILE,
    "betelgeuz.target.host",
    "betelgeuz.target.port",
    "betelgeuz.target.username",
    "betelgeuz.target.credentialRef",
    "betelgeuz.target.hostKey",
    "betelgeuz.target.deviceId",
    "betelgeuz.target.boardId",
    "betelgeuz.target.socId",
    "betelgeuz.target.keepaliveSeconds",
    "betelgeuz.target.proxyChain",
    ATTACH_STRATEGY,
    DEPLOY_LOCAL_TARGET,
    DEPLOY_ARTIFACT,
    DEPLOY_REMOTE_PATH,
    DEPLOY_EXECUTABLE,
    DEPLOY_ARGS,
    DEPLOY_CWD,
    DEPLOY_ENVIRONMENT,
    DEPLOY_FILE_MODE,
    DEPLOY_RUN_COMMAND,
    DEPLOY_RUN_MODE,
    DEPLOY_SERVICE_UNIT,
];

/// Prefixes for pattern-generated keys (inline target overrides and
/// per-strategy keys).
pub const KEY_PATTERNS: &[&str] = &[TARGET_INLINE_PREFIX, ATTACH_PREFIX];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_keys_use_the_full_strategy_id() {
        assert_eq!(
            strategy_key("linux.remoteproc", "instance"),
            "betelgeuz.attach.linux.remoteproc.instance"
        );
    }
}
