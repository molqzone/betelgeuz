//! JSON-RPC method surface: namespaced `betelgeuz/*` requests and
//! notifications. Requests carry artifact records and paths only — artifact
//! bytes never cross the RPC channel; the core transfers them over SFTP.

use serde::{Deserialize, Serialize};

// Requests (expect a response).
pub const INITIALIZE: &str = "betelgeuz/initialize";
pub const SHUTDOWN: &str = "betelgeuz/shutdown";
pub const PING: &str = "betelgeuz/ping";
pub const RESOLVE_PROFILE: &str = "betelgeuz/resolveProfile";
pub const ATTACH: &str = "betelgeuz/attach";
pub const DISCONNECT: &str = "betelgeuz/disconnect";
pub const ARTIFACT_HANDOFF: &str = "betelgeuz/artifactHandoff";
pub const DEPLOY: &str = "betelgeuz/deploy";
pub const START: &str = "betelgeuz/start";
pub const STOP: &str = "betelgeuz/stop";
pub const RESTART: &str = "betelgeuz/restart";
pub const LOGS: &str = "betelgeuz/logs";
pub const INSPECT: &str = "betelgeuz/inspect";
pub const DEBUG_PREPARE: &str = "betelgeuz/debugPrepare";
pub const RESTORE_PREVIOUS: &str = "betelgeuz/restorePrevious";
pub const CANCEL: &str = "$/cancelRequest";

pub const REQUESTS: &[&str] = &[
    INITIALIZE,
    SHUTDOWN,
    PING,
    RESOLVE_PROFILE,
    ATTACH,
    DISCONNECT,
    ARTIFACT_HANDOFF,
    DEPLOY,
    START,
    STOP,
    RESTART,
    LOGS,
    INSPECT,
    DEBUG_PREPARE,
    RESTORE_PREVIOUS,
];

// Notifications (fire and forget).
pub const CONNECTION_STATE: &str = "betelgeuz/connectionState";
pub const TARGET_STATE: &str = "betelgeuz/targetState";
pub const PROGRESS: &str = "$/progress";
pub const OUTPUT: &str = "betelgeuz/output";
pub const ERROR: &str = "betelgeuz/error";

pub const NOTIFICATIONS: &[&str] = &[
    CANCEL,
    CONNECTION_STATE,
    TARGET_STATE,
    PROGRESS,
    OUTPUT,
    ERROR,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MethodContract {
    pub method: &'static str,
    pub params: &'static str,
    pub result: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotificationContract {
    pub method: &'static str,
    pub params: &'static str,
}

pub const METHOD_CONTRACTS: &[MethodContract] = &[
    MethodContract {
        method: INITIALIZE,
        params: "InitializeParams",
        result: Some("InitializeResult"),
    },
    MethodContract {
        method: SHUTDOWN,
        params: "EmptyParams",
        result: Some("null"),
    },
    MethodContract {
        method: PING,
        params: "EmptyParams",
        result: Some("PingResult"),
    },
    MethodContract {
        method: RESOLVE_PROFILE,
        params: "ResolveProfileParams",
        result: Some("ResolveProfileResult"),
    },
    MethodContract {
        method: ATTACH,
        params: "AttachRequest",
        result: Some("AttachResult"),
    },
    MethodContract {
        method: DISCONNECT,
        params: "AttachRef",
        result: Some("DisconnectResult"),
    },
    MethodContract {
        method: ARTIFACT_HANDOFF,
        params: "ArtifactHandoffParams",
        result: Some("ArtifactHandoffResult"),
    },
    MethodContract {
        method: DEPLOY,
        params: "AttachRef",
        result: Some("OperationResult"),
    },
    MethodContract {
        method: START,
        params: "AttachRef",
        result: Some("OperationResult"),
    },
    MethodContract {
        method: STOP,
        params: "AttachRef",
        result: Some("OperationResult"),
    },
    MethodContract {
        method: RESTART,
        params: "AttachRef",
        result: Some("OperationResult"),
    },
    MethodContract {
        method: LOGS,
        params: "LogsParams",
        result: Some("LogsResult"),
    },
    MethodContract {
        method: INSPECT,
        params: "AttachRef",
        result: Some("InspectResult"),
    },
    MethodContract {
        method: DEBUG_PREPARE,
        params: "AttachRef",
        result: Some("DebugPrepareResult"),
    },
    MethodContract {
        method: RESTORE_PREVIOUS,
        params: "AttachRef",
        result: Some("OperationResult"),
    },
];

pub const NOTIFICATION_CONTRACTS: &[NotificationContract] = &[
    NotificationContract {
        method: CANCEL,
        params: "CancelParams",
    },
    NotificationContract {
        method: CONNECTION_STATE,
        params: "ConnectionStateParams",
    },
    NotificationContract {
        method: TARGET_STATE,
        params: "TargetStateParams",
    },
    NotificationContract {
        method: PROGRESS,
        params: "ProgressParams",
    },
    NotificationContract {
        method: OUTPUT,
        params: "OutputParams",
    },
    NotificationContract {
        method: ERROR,
        params: "ErrorParams",
    },
];

/// Normalized record for an artifact that already exists on the frontend's
/// host. The artifact bytes remain local and are transferred by the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub path: String,
    pub target_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<String>,
    pub size: u64,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbols_path: Option<String>,
}

/// Frontend hello: carries the protocol version the frontend was built against.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    /// Frontend identity, e.g. `vscode`, `cli`.
    pub frontend: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub core_version: String,
    pub capabilities: Vec<String>,
}

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PingResult {
    pub pong: bool,
}

/// Connection state of an attach. Each state may carry an optional `lastError`
/// catalog code at the API level; failure is a presentation decision, not a
/// separate state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Attached,
    Reconnecting,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolveProfileParams {
    pub catalog: crate::config::ProfileCatalog,
    pub target: crate::config::TargetOverrides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProfile {
    pub profile_name: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub host_key_pinned: bool,
    pub device_id: Option<String>,
    pub board_id: Option<String>,
    pub soc_id: Option<String>,
    pub keepalive_seconds: u16,
    pub proxy_hops: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolveProfileResult {
    pub profile: ResolvedProfile,
}

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachRequest {
    pub catalog: crate::config::ProfileCatalog,
    pub target: crate::config::TargetOverrides,
    pub strategy_id: String,
    #[serde(default)]
    pub strategy_configuration: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_secrets: Option<crate::config::CredentialSecrets>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TargetOperation {
    Deploy,
    Start,
    Stop,
    Restart,
    RestorePrevious,
    Logs,
    DebugPrepare,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub attach_id: String,
    pub state: ConnectionState,
    pub profile: ResolvedProfile,
    pub identity: crate::descriptor::VerifiedTargetIdentity,
    pub strategy_id: String,
    pub operations: Vec<TargetOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachRef {
    pub attach_id: String,
}

pub type DisconnectParams = AttachRef;
pub type InspectParams = AttachRef;
pub type DeployParams = AttachRef;
pub type StartParams = AttachRef;
pub type StopParams = AttachRef;
pub type RestartParams = AttachRef;
pub type RestorePreviousParams = AttachRef;
pub type DebugPrepareParams = AttachRef;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
    pub state: ConnectionState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHandoffParams {
    pub attach_id: String,
    pub artifact: ArtifactRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHandoffResult {
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogsParams {
    pub attach_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default = "default_log_limit")]
    pub max_bytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub stream: OutputStream,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogsResult {
    pub chunks: Vec<OutputChunk>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectResult {
    pub state: ConnectionState,
    pub target_state: Option<String>,
    pub identity: Option<crate::descriptor::VerifiedTargetIdentity>,
    pub operations: Vec<TargetOperation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DebugPrepareResult {
    pub provider_id: String,
    pub host: String,
    pub port: u16,
    pub program: Option<String>,
    pub symbols_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum ProgressToken {
    String(String),
    Integer(i64),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub id: ProgressToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressParams {
    pub token: ProgressToken,
    pub value: ProgressValue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProgressValue {
    Begin {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        percentage: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cancellable: Option<bool>,
    },
    Report {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        percentage: Option<u32>,
    },
    End {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStateParams {
    pub attach_id: String,
    pub state: ConnectionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TargetStateParams {
    pub attach_id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OutputParams {
    pub attach_id: String,
    pub stream: OutputStream,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorParams {
    pub request_id: Option<ProgressToken>,
    pub error: crate::error::RpcError,
}

fn default_log_limit() -> u32 {
    64 * 1024
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_params_round_trip() {
        let params = InitializeParams {
            protocol_version: "0.1.0".into(),
            frontend: "vscode".into(),
            capabilities: vec!["debug".into()],
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("protocolVersion"));
        let back: InitializeParams = serde_json::from_str(&json).unwrap();
        assert_eq!(back.frontend, "vscode");
    }

    #[test]
    fn artifact_record_serializes_the_host_path_and_integrity_metadata() {
        let record = ArtifactRecord {
            path: "/build/app".into(),
            target_name: "app".into(),
            configuration: Some("Debug".into()),
            size: 128,
            content_hash: "sha256:abc".into(),
            symbols_path: Some("/build/app.debug".into()),
        };
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["targetName"], "app");
        assert_eq!(json["contentHash"], "sha256:abc");
        assert_eq!(json["symbolsPath"], "/build/app.debug");
        assert_eq!(
            serde_json::from_value::<ArtifactRecord>(json).unwrap(),
            record
        );
    }

    #[test]
    fn cancellation_and_progress_are_notifications_using_lsp_methods() {
        assert_eq!(CANCEL, "$/cancelRequest");
        assert_eq!(PROGRESS, "$/progress");
        assert!(!REQUESTS.contains(&CANCEL));
        assert!(NOTIFICATIONS.contains(&CANCEL));
        assert!(NOTIFICATIONS.contains(&PROGRESS));

        let cancel = serde_json::to_value(CancelParams {
            id: ProgressToken::String("request-1".into()),
        })
        .unwrap();
        assert_eq!(cancel["id"], "request-1");
        assert!(cancel.get("requestId").is_none());

        let progress = serde_json::to_value(ProgressParams {
            token: ProgressToken::Integer(7),
            value: ProgressValue::Begin {
                title: "Deploy".into(),
                message: None,
                percentage: Some(10),
                cancellable: Some(true),
            },
        })
        .unwrap();
        assert_eq!(progress["token"], 7);
        assert_eq!(progress["value"]["kind"], "begin");
    }

    #[test]
    fn every_declared_request_and_notification_has_a_typed_contract() {
        assert_eq!(REQUESTS.len(), METHOD_CONTRACTS.len());
        assert!(REQUESTS.iter().all(|method| METHOD_CONTRACTS
            .iter()
            .any(|contract| contract.method == *method)));
        assert_eq!(NOTIFICATIONS.len(), NOTIFICATION_CONTRACTS.len());
        assert!(NOTIFICATIONS.iter().all(|method| NOTIFICATION_CONTRACTS
            .iter()
            .any(|contract| contract.method == *method)));
    }
}
