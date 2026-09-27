//! JSON-RPC 2.0 over Tokio stdio: LSP-style `Content-Length` framing.
//!
//! This module owns wire framing and protocol dispatch only. Connection
//! policy, profile resolution, and transport calls live in [`crate::service`].

use std::io;

use errors::{BetelgeuzError, ErrorCode};
use protocol::{
    config::CredentialSecrets,
    error::{RpcError, RpcErrorData},
    methods::{
        self, AttachRef, AttachRequest, InitializeParams, InitializeResult, InspectHostKeyParams,
        ResolveProfileParams,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroize;

use crate::service::{CoreRequest, CoreResponse, RequestHandler};

pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;

pub async fn read_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
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
            let len = content_length.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "message without Content-Length header",
                )
            })?;
            if len > protocol::MAX_MESSAGE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "message exceeds the maximum allowed size",
                ));
            }
            let mut body = vec![0u8; len];
            if let Err(error) = reader.read_exact(&mut body).await {
                body.zeroize();
                return Err(error);
            }
            let parsed = serde_json::from_slice(&body)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
            body.zeroize();
            return parsed.map(Some);
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                if content_length.is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "duplicate Content-Length header",
                    ));
                }
                content_length = Some(value.trim().parse().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid Content-Length header")
                })?);
            }
        }
    }
}

pub async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > protocol::MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message exceeds the maximum allowed size",
        ));
    }
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await?;
    writer.write_all(&body).await?;
    writer.flush().await
}

#[cfg(test)]
pub fn dispatch(mut message: Value) -> Option<Value> {
    let Some(id) = message.get("id").cloned() else {
        return None;
    };
    let Some(method) = message
        .get("method")
        .and_then(Value::as_str)
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
    Some(match method.as_str() {
        methods::PING => result_response(id, json!({ "pong": true })),
        methods::SHUTDOWN => result_response(id, Value::Null),
        methods::INITIALIZE => initialize_response(id, params),
        _ => error_response(
            id,
            RpcError::protocol(
                METHOD_NOT_FOUND,
                format!("method not implemented: {method}"),
            ),
        ),
    })
}

pub async fn dispatch_async<H: RequestHandler>(
    mut message: Value,
    handler: &mut H,
) -> Option<Value> {
    let Some(id) = message.get("id").cloned() else {
        return None;
    };
    let Some(method) = message
        .get("method")
        .and_then(Value::as_str)
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
        methods::INSPECT_HOST_KEY => match serde_json::from_value::<InspectHostKeyParams>(params) {
            Ok(request) => service_response(
                id,
                handler
                    .handle_request(CoreRequest::InspectHostKey(request))
                    .await,
            ),
            Err(error) => {
                error_response(id, RpcError::protocol(INVALID_REQUEST, error.to_string()))
            }
        },
        methods::RESOLVE_PROFILE => match serde_json::from_value::<ResolveProfileParams>(params) {
            Ok(request) => service_response(
                id,
                handler
                    .handle_request(CoreRequest::ResolveProfile(request))
                    .await,
            ),
            Err(error) => {
                error_response(id, RpcError::protocol(INVALID_REQUEST, error.to_string()))
            }
        },
        methods::ATTACH => match parse_attach_request(params) {
            Ok(request) => service_response(
                id,
                handler.handle_request(CoreRequest::Attach(request)).await,
            ),
            Err(error) => error_response(id, RpcError::protocol(INVALID_REQUEST, error)),
        },
        methods::DISCONNECT => match serde_json::from_value::<AttachRef>(params) {
            Ok(request) => service_response(
                id,
                handler
                    .handle_request(CoreRequest::Disconnect(request))
                    .await,
            ),
            Err(error) => {
                error_response(id, RpcError::protocol(INVALID_REQUEST, error.to_string()))
            }
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

pub async fn serve<R, W, H>(reader: &mut R, writer: &mut W, handler: &mut H) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    H: RequestHandler,
{
    while let Some(message) = read_message(reader).await? {
        let is_shutdown = message.get("method").and_then(Value::as_str) == Some(methods::SHUTDOWN);
        if let Some(response) = dispatch_async(message, handler).await {
            write_message(writer, &response).await?;
        }
        if is_shutdown {
            break;
        }
    }
    Ok(())
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
            let parsed = CredentialSecrets::deserialize(&value).map_err(|error| error.to_string());
            zeroize_json(&mut value);
            Some(parsed?)
        }
    };
    let mut request: AttachRequest =
        serde_json::from_value(params).map_err(|error| error.to_string())?;
    request.credential_secrets = credential_secrets;
    Ok(request)
}

fn valid_credential_secrets_shape(value: &Value) -> bool {
    value.as_object().is_some_and(|fields| {
        fields.values().all(|value| {
            value.as_object().is_some_and(|fields| {
                fields.iter().all(|(name, value)| {
                    matches!(name.as_str(), "password" | "passphrase")
                        && (value.is_null() || value.is_string())
                })
            })
        })
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
        Err(error) => {
            return error_response(id, RpcError::protocol(INVALID_REQUEST, error.to_string()));
        }
    };
    if parsed.protocol_version != protocol::PROTOCOL_VERSION {
        let error = BetelgeuzError::new(ErrorCode::ProtocolMismatch).with_detail(format!(
            "core {}, frontend {}",
            protocol::PROTOCOL_VERSION,
            parsed.protocol_version
        ));
        return error_response(id, application_error(&error));
    }
    result_response(
        id,
        serde_json::to_value(InitializeResult {
            protocol_version: protocol::PROTOCOL_VERSION.to_string(),
            core_version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: Vec::new(),
        })
        .expect("InitializeResult serializes"),
    )
}

fn service_response(id: Value, result: Result<CoreResponse, BetelgeuzError>) -> Value {
    match result {
        Ok(response) => result_response(id, core_response_value(response)),
        Err(error) => error_response(id, application_error(&error)),
    }
}

fn core_response_value(response: CoreResponse) -> Value {
    match response {
        CoreResponse::ResolveProfile(value) => serde_json::to_value(value),
        CoreResponse::InspectHostKey(value) => serde_json::to_value(value),
        CoreResponse::Attach(value) => serde_json::to_value(value),
        CoreResponse::Disconnect(value) => serde_json::to_value(value),
    }
    .expect("core response serializes")
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn framing_round_trips() {
        let original = json!({ "jsonrpc": "2.0", "id": 1, "method": "betelgeuz/ping" });
        let mut buffer = Vec::new();
        write_message(&mut buffer, &original).await.unwrap();
        let mut cursor = BufReader::new(Cursor::new(buffer));
        assert_eq!(read_message(&mut cursor).await.unwrap().unwrap(), original);
        assert!(read_message(&mut cursor).await.unwrap().is_none());
    }

    #[test]
    fn initialize_negotiates_version() {
        let response = dispatch(json!({ "jsonrpc": "2.0", "id": 7, "method": "betelgeuz/initialize", "params": { "protocolVersion": protocol::PROTOCOL_VERSION, "frontend": "vscode" } })).unwrap();
        assert_eq!(
            response["result"]["protocolVersion"],
            protocol::PROTOCOL_VERSION
        );
    }

    #[test]
    fn initialize_version_mismatch_is_structured() {
        let response = dispatch(json!({ "jsonrpc": "2.0", "id": 8, "method": "betelgeuz/initialize", "params": { "protocolVersion": "9.9.9", "frontend": "vscode" } })).unwrap();
        assert_eq!(response["error"]["data"]["code"], "protocol.mismatch");
    }

    #[test]
    fn unknown_method_reports_method_not_found() {
        let response =
            dispatch(json!({ "jsonrpc": "2.0", "id": 9, "method": "betelgeuz/nope" })).unwrap();
        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn rpc_body_size_limit_is_checked_before_allocating_the_body() {
        let header = format!(
            "Content-Length: {}\r\n\r\n",
            protocol::MAX_MESSAGE_BYTES + 1
        );
        let mut reader = BufReader::new(Cursor::new(header.into_bytes()));
        assert_eq!(
            read_message(&mut reader).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
