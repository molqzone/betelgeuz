//! JSON-RPC error wire types. Error codes and remediation metadata are owned
//! by the core and strategy layers; this module only defines their wire shape.

use serde::Serialize;

/// JSON-RPC application error code used for structured Betelgeuz failures.
pub const APPLICATION_ERROR_CODE: i64 = -32000;

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<RpcErrorData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorData {
    pub code: String,
    pub phase: String,
    pub retriable: bool,
    /// Stable action identifier for frontend-specific presentation.
    pub remediation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl RpcError {
    pub fn application(message: impl Into<String>, data: RpcErrorData) -> Self {
        RpcError {
            code: APPLICATION_ERROR_CODE,
            message: message.into(),
            data: Some(data),
        }
    }

    /// A JSON-RPC-level error (parse, invalid request, unknown method).
    pub fn protocol(code: i64, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_error_serializes_machine_readable_metadata() {
        let error = RpcError::application(
            "betelgeuz.ssh.lost: connection dropped",
            RpcErrorData {
                code: "ssh.lost".into(),
                phase: "connect".into(),
                retriable: true,
                remediation: "retry".into(),
                target_state: None,
                detail: Some("eof".into()),
            },
        );
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["data"]["code"], "ssh.lost");
        assert_eq!(value["data"]["remediation"], "retry");
        assert_eq!(value["data"]["detail"], "eof");
    }
}
