//! JSON-RPC error wire types. Error codes and remediation metadata are owned
//! by the core and strategy layers; this module only defines their wire shape.

use serde::Serialize;

/// JSON-RPC application error code used for structured Betelgeuz failures.
pub const APPLICATION_ERROR_CODE: i64 = -32000;

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<RpcErrorData>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
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
    use expect_test::expect;

    #[test]
    fn application_error_wire_shape_is_pinned() {
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
        expect![[r#"
            {
              "code": -32000,
              "data": {
                "code": "ssh.lost",
                "detail": "eof",
                "phase": "connect",
                "remediation": "retry",
                "retriable": true
              },
              "message": "betelgeuz.ssh.lost: connection dropped"
            }"#]].assert_eq(&serde_json::to_string_pretty(&value).unwrap());
    }
}
