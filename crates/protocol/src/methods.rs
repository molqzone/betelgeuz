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
pub const CANCEL: &str = "betelgeuz/cancel";

// Notifications (fire and forget).
pub const CONNECTION_STATE: &str = "betelgeuz/connectionState";
pub const TARGET_STATE: &str = "betelgeuz/targetState";
pub const PROGRESS: &str = "betelgeuz/progress";
pub const OUTPUT: &str = "betelgeuz/output";

// TODO(Phase 0): typed params/results for each request above. The shapes below
// cover the initialize handshake; the rest land with the services that serve
// them (attach manager, deploy pipeline, strategy registry).

/// Frontend hello: carries the protocol version the frontend was built against.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    /// Frontend identity, e.g. `vscode`, `cli`.
    pub frontend: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub core_version: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Attached,
    Reconnecting,
    Failed,
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
}
