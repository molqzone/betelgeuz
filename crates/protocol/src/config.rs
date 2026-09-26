//! Configuration keys: the two-layer model of target profiles (user-level,
//! shared across workspaces) and attach configuration (workspace-scoped).
//!
//! The concrete per-strategy key lists are a Phase 0 work item; these constants
//! are the shared surface. Frontends generate their settings schema from here.

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

/// Per-strategy keys live under `betelgeuz.attach.<strategy>.<key>`.
pub fn strategy_key(strategy: &str, key: &str) -> String {
    format!("{ATTACH_PREFIX}{strategy}.{key}")
}

/// The CMake target whose already-built artifact is consumed. Never a build
/// invocation.
pub const DEPLOY_LOCAL_TARGET: &str = "betelgeuz.deploy.localTarget";

/// Multi-artifact disambiguation (suffix or pattern). Later-phase key; the MVP
/// deploys only targets with exactly one artifact.
pub const DEPLOY_ARTIFACT: &str = "betelgeuz.deploy.artifact";

pub const DEPLOY_REMOTE_PATH: &str = "betelgeuz.deploy.remotePath";
pub const DEPLOY_RUN_COMMAND: &str = "betelgeuz.deploy.runCommand";
pub const DEPLOY_RUN_MODE: &str = "betelgeuz.deploy.runMode";
/// A unit provisioned on the target; Betelgeuz never generates unit files.
pub const DEPLOY_SERVICE_UNIT: &str = "betelgeuz.deploy.serviceUnit";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_keys_are_namespaced() {
        assert_eq!(ATTACH_STRATEGY, "betelgeuz.attach.strategy");
        assert_eq!(
            strategy_key("linux.remoteproc", "instance"),
            "betelgeuz.attach.linux.remoteproc.instance"
        );
    }
}
