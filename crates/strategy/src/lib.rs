//! Deploy strategies are peers behind one core-selected contract, not hardcoded
//! command branches. Each entry declares its ID, role, configuration schema,
//! error namespace, privilege class, and operation set. The user selects an
//! implemented strategy; it validates target compatibility after identity
//! binding and never participates in board discovery or automatic selection.
//!
//! Strategies share the core's SSH session and provide workflow-specific
//! artifact validation, staging, commit, activation, lifecycle, inspection,
//! and logs. The shared pipeline coordinates those steps and owns its common
//! commit-point, progress, cancellation, locking, and retention behavior.

use std::{collections::HashSet, sync::Arc};

use async_trait::async_trait;
use errors::{BetelgeuzError, ErrorCatalogEntry, ErrorCode, ErrorDef, Phase};
use protocol::{descriptor::HardwareDescriptor, methods::ArtifactRecord};
use serde_json::Value;
use transport::{OutputStream, SshSession};

/// Error metadata owned by the strategy that defines the corresponding codes.
pub const ERROR_CATALOG: &[ErrorCatalogEntry] = &[
    ErrorCatalogEntry {
        code: "rproc.instance-missing",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: false,
            remediation: "selectSupportedStrategy",
            summary: "The board exposes no supported small-core control interface for the configured core.",
        },
    },
    ErrorCatalogEntry {
        code: "rproc.stop-failed",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: true,
            remediation: "retry",
            summary: "Stopping the small core failed; the deployed firmware is untouched.",
        },
    },
    ErrorCatalogEntry {
        code: "rproc.crashed",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: false,
            remediation: "restorePreviousVersion",
            summary: "The small core entered the crashed state; carries the kernel log tail when readable.",
        },
    },
    ErrorCatalogEntry {
        code: "rproc.state-timeout",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: true,
            remediation: "inspectTrace",
            summary: "Timed out waiting for the core state transition; carries the last observed state.",
        },
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigKey {
    pub strategy_id: &'static str,
    pub name: &'static str,
}

/// The first strategy-owned settings keys are fixed even before the strategy
/// implementation lands, keeping editors' settings surfaces stable.
pub const CONFIG_KEYS: &[ConfigKey] = &[
    ConfigKey {
        strategy_id: "linux.remoteproc",
        name: "instance",
    },
    ConfigKey {
        strategy_id: "linux.remoteproc",
        name: "firmwarePath",
    },
];

pub fn builtin_config_schemas() -> Vec<(&'static str, Value)> {
    vec![(
        "linux.remoteproc",
        serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "linux.remoteproc configuration",
            "type": "object",
            "properties": {
                "instance": { "type": "string", "minLength": 1 },
                "firmwarePath": { "type": "string", "minLength": 1 }
            },
            "required": ["instance", "firmwarePath"],
            "additionalProperties": false
        }),
    )]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    BigCoreApplication,
    SmallCoreFirmware,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivilegeClass {
    User,
    FixedCommandSudo,
    Root,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Operation {
    Deploy,
    Start,
    Stop,
    Restart,
    RestorePrevious,
    Logs,
    DebugPrepare,
}

#[derive(Debug, Clone)]
pub struct StrategyMetadata {
    pub id: &'static str,
    pub role: Role,
    /// JSON Schema object describing this strategy's settings.
    pub config_schema: Value,
    /// Prefix before the first `.` in each entry from `error_catalog`.
    pub error_namespace: &'static str,
    pub error_catalog: &'static [ErrorCatalogEntry],
    pub privilege_class: PrivilegeClass,
    pub operations: Vec<Operation>,
}

pub struct StrategyContext<'a> {
    pub session: &'a dyn SshSession,
    pub target: &'a HardwareDescriptor,
    pub configuration: &'a Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetCapabilities {
    pub operations: Vec<Operation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleAction {
    Start,
    Stop,
    Restart,
    RestorePrevious,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StagedArtifact {
    pub temporary_path: String,
    pub final_path: String,
    pub strategy_state: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommitReceipt {
    pub active_path: String,
    pub previous_path: Option<String>,
    pub strategy_state: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetState {
    pub status: String,
    pub active_artifact: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogQuery {
    pub cursor: Option<String>,
    pub max_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogChunk {
    pub stream: OutputStream,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogBatch {
    pub chunks: Vec<LogChunk>,
    pub next_cursor: Option<String>,
}

#[async_trait]
pub trait DeployStrategy: Send + Sync {
    fn metadata(&self) -> &StrategyMetadata;

    /// Returns the operations that remain usable, or
    /// `strategy.unsupported-target` when a required target interface is absent.
    async fn validate_target(
        &self,
        context: StrategyContext<'_>,
    ) -> Result<TargetCapabilities, BetelgeuzError>;

    async fn validate_artifact(
        &self,
        context: &StrategyContext<'_>,
        artifact: &ArtifactRecord,
    ) -> Result<(), BetelgeuzError>;

    async fn stage(
        &self,
        context: &StrategyContext<'_>,
        artifact: &ArtifactRecord,
    ) -> Result<StagedArtifact, BetelgeuzError>;

    async fn commit(
        &self,
        context: &StrategyContext<'_>,
        staged: StagedArtifact,
    ) -> Result<CommitReceipt, BetelgeuzError>;

    async fn activate(
        &self,
        context: &StrategyContext<'_>,
        committed: &CommitReceipt,
    ) -> Result<(), BetelgeuzError>;

    async fn rollback(
        &self,
        context: &StrategyContext<'_>,
        committed: CommitReceipt,
    ) -> Result<(), BetelgeuzError>;

    async fn lifecycle(
        &self,
        context: &StrategyContext<'_>,
        action: LifecycleAction,
    ) -> Result<(), BetelgeuzError>;

    async fn inspect(&self, context: &StrategyContext<'_>) -> Result<TargetState, BetelgeuzError>;

    async fn logs(
        &self,
        context: &StrategyContext<'_>,
        query: LogQuery,
    ) -> Result<LogBatch, BetelgeuzError>;
}

/// Compile-time assembled strategy set. It deliberately has no runtime plugin
/// loader; core selects entries by explicit ID or presents them grouped by role.
pub struct StrategyRegistry {
    strategies: Vec<Arc<dyn DeployStrategy>>,
}

impl StrategyRegistry {
    pub fn new(strategies: Vec<Arc<dyn DeployStrategy>>) -> Result<Self, BetelgeuzError> {
        let metadata: Vec<_> = strategies
            .iter()
            .map(|strategy| strategy.metadata())
            .collect();
        validate_metadata(&metadata)?;
        Ok(Self { strategies })
    }

    pub fn get(&self, id: &str) -> Option<&Arc<dyn DeployStrategy>> {
        self.strategies
            .iter()
            .find(|strategy| strategy.metadata().id == id)
    }

    pub fn for_role(&self, role: Role) -> impl Iterator<Item = &Arc<dyn DeployStrategy>> {
        self.strategies
            .iter()
            .filter(move |strategy| strategy.metadata().role == role)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn DeployStrategy>> {
        self.strategies.iter()
    }
}

fn validate_metadata(metadata: &[&StrategyMetadata]) -> Result<(), BetelgeuzError> {
    let mut ids = HashSet::new();
    let mut namespaces = HashSet::new();
    let mut codes: HashSet<&'static str> = errors::ErrorCode::ALL
        .into_iter()
        .map(ErrorCode::code)
        .collect();

    for item in metadata {
        if item.id.trim().is_empty()
            || item.error_namespace.trim().is_empty()
            || !item.config_schema.is_object()
        {
            return Err(invalid_registry(
                "strategy ID, error namespace, and object config schema are required",
            ));
        }
        if !ids.insert(item.id) {
            return Err(invalid_registry(format!(
                "duplicate strategy ID `{}`",
                item.id
            )));
        }
        if !namespaces.insert(item.error_namespace) {
            return Err(invalid_registry(format!(
                "duplicate error namespace `{}`",
                item.error_namespace
            )));
        }
        for entry in item.error_catalog {
            let expected_prefix = format!("{}.", item.error_namespace);
            if !entry.code.starts_with(&expected_prefix) {
                return Err(invalid_registry(format!(
                    "error `{}` is outside namespace `{}`",
                    entry.code, item.error_namespace
                )));
            }
            if !codes.insert(entry.code) {
                return Err(invalid_registry(format!(
                    "duplicate error code `{}`",
                    entry.code
                )));
            }
        }
    }
    Ok(())
}

fn invalid_registry(detail: impl Into<String>) -> BetelgeuzError {
    BetelgeuzError::new(ErrorCode::ConfigInvalid).with_detail(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(
        id: &'static str,
        namespace: &'static str,
        catalog: &'static [ErrorCatalogEntry],
    ) -> StrategyMetadata {
        StrategyMetadata {
            id,
            role: Role::BigCoreApplication,
            config_schema: serde_json::json!({ "type": "object" }),
            error_namespace: namespace,
            error_catalog: catalog,
            privilege_class: PrivilegeClass::User,
            operations: vec![Operation::Deploy],
        }
    }

    #[test]
    fn registry_contract_rejects_duplicate_ids_and_wrong_error_namespaces() {
        let first = metadata("linux.ssh-app", "sshapp", &[]);
        let duplicate = metadata("linux.ssh-app", "sshapp2", &[]);
        let error = validate_metadata(&[&first, &duplicate]).unwrap_err();
        assert!(error.detail.unwrap().contains("duplicate strategy ID"));

        static WRONG_CATALOG: [ErrorCatalogEntry; 1] = [ErrorCatalogEntry {
            code: "other.failure",
            definition: ErrorDef {
                phase: Some(Phase::Deploy),
                retriable: false,
                remediation: "retry",
                summary: "Failure.",
            },
        }];
        let wrong_namespace = metadata("linux.remoteproc", "rproc", &WRONG_CATALOG);
        let error = validate_metadata(&[&wrong_namespace]).unwrap_err();
        assert!(error.detail.unwrap().contains("outside namespace"));
    }

    #[test]
    fn strategy_configuration_keys_use_the_strategy_id_namespace() {
        let keys: Vec<_> = CONFIG_KEYS
            .iter()
            .map(|key| protocol::config::strategy_key(key.strategy_id, key.name))
            .collect();
        assert_eq!(
            keys,
            [
                "betelgeuz.attach.linux.remoteproc.instance",
                "betelgeuz.attach.linux.remoteproc.firmwarePath"
            ]
        );
        let schema = builtin_config_schemas().pop().unwrap().1;
        assert_eq!(schema["required"][0], "instance");
        assert_eq!(schema["required"][1], "firmwarePath");
    }
}
