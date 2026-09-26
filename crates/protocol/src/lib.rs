//! Single source of truth for the extension/core contract.
//!
//! This crate owns:
//! - the JSON-RPC 2.0 method surface ([`methods`], `betelgeuz/*` names);
//! - the initialize handshake and protocol version negotiation ([`negotiate`]);
//! - the error catalog ([`error`]) documented in `docs/ERRORS.md`;
//! - the hardware descriptor schema ([`descriptor`]);
//! - the configuration key surface ([`config`]).
//!
//! Generated artifacts (JSON Schema, TypeScript types, `docs/ERRORS.md`) are
//! produced by `cargo xtask gen-*` from this crate and never hand-edited. The
//! crate forbids: editor dependencies, transport dependencies, and any
//! knowledge of strategies' target semantics.

pub mod config;
pub mod descriptor;
pub mod error;
pub mod methods;

pub use descriptor::HardwareDescriptor;
pub use error::{BetelgeuzError, ErrorCode, Phase, RpcError};
pub use methods::{InitializeParams, InitializeResult};

/// Protocol version negotiated during the initialize handshake.
pub const PROTOCOL_VERSION: &str = "0.1.0";

/// JSON-RPC method namespace.
pub const METHOD_NAMESPACE: &str = "betelgeuz";

/// Version negotiation: while the protocol is `0.x`, versions must match
/// exactly. A mismatch is a `protocol.mismatch` error, never a silent
/// degradation.
pub fn negotiate(requested: &str) -> Result<String, BetelgeuzError> {
    if requested == PROTOCOL_VERSION {
        Ok(PROTOCOL_VERSION.to_string())
    } else {
        Err(BetelgeuzError::new(ErrorCode::ProtocolMismatch)
            .with_detail(format!("core {PROTOCOL_VERSION}, frontend {requested}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiate_accepts_matching_version() {
        assert_eq!(negotiate(PROTOCOL_VERSION).unwrap(), PROTOCOL_VERSION);
    }

    #[test]
    fn negotiate_rejects_mismatch() {
        let err = negotiate("9.9.9").unwrap_err();
        assert_eq!(err.code, ErrorCode::ProtocolMismatch);
    }
}
