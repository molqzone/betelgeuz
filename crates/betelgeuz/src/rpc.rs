//! JSON-RPC 2.0 over stdio: LSP-style `Content-Length` framing.
//!
//! This module is transport-of-transport: it moves messages between the
//! frontend and the dispatch surface. It knows nothing about SSH, attach, or
//! strategies. The loop is synchronous for now; it moves to the async runtime
//! when the russh transport lands (Phase 1).

use std::io::{self, BufRead, Write};

use errors::{BetelgeuzError, ErrorCode};
use protocol::{
    error::{RpcError, RpcErrorData},
    methods::{self, AttachRequest, InitializeParams, InitializeResult},
    negotiate,
};
use serde_json::{json, Value};
use zeroize::Zeroize;

// Standard JSON-RPC error codes for protocol-level failures.
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;

/// Reads one framed message. `Ok(None)` at clean end-of-stream.
pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return match content_length {
                None => Ok(None),
                Some(_) => Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "end of stream inside message header",
                )),
            };
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            return match content_length {
                Some(len) => {
                    if len > protocol::MAX_MESSAGE_BYTES {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "message exceeds the maximum allowed size",
                        ));
                    }
                    let mut body = vec![0u8; len];
                    if let Err(error) = reader.read_exact(&mut body) {
                        body.zeroize();
                        return Err(error);
                    }
                    let parsed = serde_json::from_slice(&body);
                    body.zeroize();
                    let value =
                        parsed.map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
                    Ok(Some(value))
                }
                None => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "message without Content-Length header",
                )),
            };
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().ok();
            }
        }
    }
}

pub fn write_message(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

/// Dispatches one message. Returns `None` for notifications. Unimplemented
/// methods answer `method not found` until the service that owns them lands.
pub fn dispatch(mut message: Value) -> Option<Value> {
    let Some(id) = message.get("id").cloned() else {
        return None; // notification
    };
    let Some(method) = message
        .get("method")
        .and_then(|m| m.as_str())
        .map(str::to_owned)
    else {
        return Some(error_response(
            id,
            RpcError::protocol(INVALID_REQUEST, "missing method"),
        ));
    };
    let params = message
        .as_object_mut()
        .and_then(|object| object.remove("params"))
        .unwrap_or(Value::Null);
    let response = match method.as_str() {
        methods::PING => result_response(id, json!({ "pong": true })),
        methods::SHUTDOWN => result_response(id, Value::Null),
        methods::INITIALIZE => initialize_response(id, params),
        methods::ATTACH => match parse_attach_request(params) {
            Ok(request) => {
                drop(request);
                error_response(
                    id,
                    RpcError::protocol(
                        METHOD_NOT_FOUND,
                        "method not implemented: betelgeuz/attach",
                    ),
                )
            }
            Err(error) => error_response(id, RpcError::protocol(INVALID_REQUEST, error)),
        },
        _ => error_response(
            id,
            RpcError::protocol(
                METHOD_NOT_FOUND,
                format!("method not implemented: {method}"),
            ),
        ),
    };
    Some(response)
}

fn parse_attach_request(mut params: Value) -> Result<AttachRequest, String> {
    let credentials = params
        .as_object_mut()
        .and_then(|object| object.remove("credentialSecrets"));
    let credential_secrets = match credentials {
        None | Some(Value::Null) => None,
        Some(mut value) => {
            if !valid_credential_secrets_shape(&value) {
                zeroize_json(&mut value);
                return Err(
                    "credentialSecrets must map references to password/passphrase values".into(),
                );
            }
            Some(serde_json::from_value(value).map_err(|error| error.to_string())?)
        }
    };
    if !valid_attach_shape(&params) {
        zeroize_json(&mut params);
        return Err("attach params contain unknown fields".into());
    }
    let mut request: AttachRequest =
        serde_json::from_value(params).map_err(|error| error.to_string())?;
    request.credential_secrets = credential_secrets;
    Ok(request)
}

fn valid_attach_shape(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields.keys().all(|name| {
        matches!(
            name.as_str(),
            "catalog" | "target" | "strategyId" | "strategyConfiguration"
        )
    })
}

fn valid_credential_secrets_shape(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields.values().all(valid_credential_material_shape)
}

fn valid_credential_material_shape(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields.iter().all(|(name, value)| {
        matches!(name.as_str(), "password" | "passphrase") && (value.is_null() || value.is_string())
    })
}

fn zeroize_json(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(items) => items.iter_mut().for_each(zeroize_json),
        Value::Object(fields) => fields.values_mut().for_each(zeroize_json),
        _ => {}
    }
}

fn initialize_response(id: Value, params: Value) -> Value {
    let parsed: InitializeParams = match serde_json::from_value(params) {
        Ok(parsed) => parsed,
        Err(e) => return error_response(id, RpcError::protocol(INVALID_REQUEST, e.to_string())),
    };
    match negotiate(&parsed.protocol_version) {
        Ok(version) => result_response(
            id,
            serde_json::to_value(InitializeResult {
                protocol_version: version,
                core_version: env!("CARGO_PKG_VERSION").to_string(),
                capabilities: Vec::new(), // grows with the service surface (Phase 0+)
            })
            .expect("InitializeResult serializes"),
        ),
        Err(err) => {
            let error =
                BetelgeuzError::new(ErrorCode::ProtocolMismatch).with_detail(err.to_string());
            error_response(id, application_error(&error))
        }
    }
}

fn application_error(err: &BetelgeuzError) -> RpcError {
    RpcError::application(
        err.to_string(),
        RpcErrorData {
            code: err.code.to_string(),
            phase: err.phase.as_str().to_string(),
            retriable: err.retriable,
            remediation: err.remediation.to_string(),
            target_state: err.target_state.clone(),
            detail: err.detail.clone(),
        },
    )
}

fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, error: RpcError) -> Value {
    let mut message = json!({ "jsonrpc": "2.0", "id": id });
    message["error"] = serde_json::to_value(error).expect("RpcError serializes");
    message
}

/// Serves the stdio loop until shutdown or end-of-stream.
pub fn serve(reader: &mut impl BufRead, writer: &mut impl Write) -> io::Result<()> {
    while let Some(message) = read_message(reader)? {
        let is_shutdown = message.get("method").and_then(|m| m.as_str()) == Some(methods::SHUTDOWN);
        if let Some(response) = dispatch(message) {
            write_message(writer, &response)?;
        }
        if is_shutdown {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn framing_round_trips() {
        let original = json!({ "jsonrpc": "2.0", "id": 1, "method": "betelgeuz/ping" });
        let mut buffer = Vec::new();
        write_message(&mut buffer, &original).unwrap();
        let mut cursor = Cursor::new(buffer);
        let read = read_message(&mut cursor).unwrap().unwrap();
        assert_eq!(read, original);
        assert!(read_message(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn initialize_negotiates_version() {
        let response = dispatch(json!({
            "jsonrpc": "2.0", "id": 7, "method": "betelgeuz/initialize",
            "params": { "protocolVersion": protocol::PROTOCOL_VERSION, "frontend": "vscode" }
        }))
        .unwrap();
        assert_eq!(
            response["result"]["protocolVersion"],
            protocol::PROTOCOL_VERSION
        );
    }

    #[test]
    fn initialize_version_mismatch_is_structured() {
        let response = dispatch(json!({
            "jsonrpc": "2.0", "id": 8, "method": "betelgeuz/initialize",
            "params": { "protocolVersion": "9.9.9", "frontend": "vscode" }
        }))
        .unwrap();
        assert_eq!(response["error"]["data"]["code"], "protocol.mismatch");
        assert_eq!(response["error"]["data"]["remediation"], "upgradeFrontend");
    }

    #[test]
    fn unknown_method_reports_method_not_found() {
        let response =
            dispatch(json!({ "jsonrpc": "2.0", "id": 9, "method": "betelgeuz/nope" })).unwrap();
        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn notifications_produce_no_response() {
        assert!(dispatch(json!({ "jsonrpc": "2.0", "method": "betelgeuz/progress" })).is_none());
    }

    #[test]
    fn attach_request_consumes_ephemeral_credentials_without_echoing_them() {
        let response = dispatch(json!({
            "jsonrpc": "2.0", "id": 10, "method": methods::ATTACH,
            "params": {
                "catalog": {},
                "target": { "host": "board.local", "username": "root", "credentialRef": "board" },
                "strategyId": "linux.ssh-app",
                "credentialSecrets": { "board": { "password": "one-use-secret" } }
            }
        }))
        .unwrap();

        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
        assert!(!response.to_string().contains("one-use-secret"));
    }

    #[test]
    fn rpc_body_size_limit_is_checked_before_allocating_the_body() {
        let header = format!(
            "Content-Length: {}\r\n\r\n",
            protocol::MAX_MESSAGE_BYTES + 1
        );
        let mut reader = Cursor::new(header.into_bytes());
        let error = read_message(&mut reader).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
