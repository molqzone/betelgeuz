//! JSON-RPC 2.0 over stdio: LSP-style `Content-Length` framing.
//!
//! This module is transport-of-transport: it moves messages between the
//! frontend and the dispatch surface. It knows nothing about SSH, attach, or
//! strategies. The loop is synchronous for now; it moves to the async runtime
//! when the russh transport lands (Phase 1).

use std::io::{self, BufRead, Read, Write};

use protocol::{
    error::{ErrorCode, RpcError},
    methods::{self, InitializeParams, InitializeResult},
    negotiate, BetelgeuzError,
};
use serde_json::{json, Value};

// Standard JSON-RPC error codes for protocol-level failures.
pub const PARSE_ERROR: i64 = -32700;
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
                    let mut body = vec![0u8; len];
                    reader.read_exact(&mut body)?;
                    let value = serde_json::from_slice(&body)
                        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
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
pub fn dispatch(message: Value) -> Option<Value> {
    let Some(id) = message.get("id").cloned() else {
        return None; // notification
    };
    let Some(method) = message.get("method").and_then(|m| m.as_str()) else {
        return Some(error_response(id, RpcError::protocol(INVALID_REQUEST, "missing method")));
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let response = match method {
        methods::PING => result_response(id, json!({ "pong": true })),
        methods::SHUTDOWN => result_response(id, Value::Null),
        methods::INITIALIZE => initialize_response(id, params),
        _ => error_response(
            id,
            RpcError::protocol(METHOD_NOT_FOUND, format!("method not implemented: {method}")),
        ),
    };
    Some(response)
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
        Err(err) => error_response(id, RpcError::application(&err)),
    }
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

/// Converts an unexpected failure into a catalog error for the log.
pub fn unexpected(phase: protocol::Phase, cause: impl std::fmt::Display) -> BetelgeuzError {
    BetelgeuzError::wrap_unexpected(phase, cause)
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
        assert_eq!(response["result"]["protocolVersion"], protocol::PROTOCOL_VERSION);
    }

    #[test]
    fn initialize_version_mismatch_is_structured() {
        let response = dispatch(json!({
            "jsonrpc": "2.0", "id": 8, "method": "betelgeuz/initialize",
            "params": { "protocolVersion": "9.9.9", "frontend": "vscode" }
        }))
        .unwrap();
        assert_eq!(response["error"]["data"]["code"], "protocol.mismatch");
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
}
