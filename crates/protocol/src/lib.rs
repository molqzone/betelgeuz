//! Single source of truth for the extension/core contract.
//!
//! This crate owns:
//! - the JSON-RPC 2.0 method surface ([`methods`], `betelgeuz/*` names);
//! - the initialize handshake and protocol version negotiation ([`negotiate`]);
//! - the JSON-RPC error wire envelope ([`error::RpcError`]);
//! - the hardware descriptor schema ([`descriptor`]);
//! - the configuration key surface ([`config`]).
//!
//! Generated protocol artifacts (JSON Schema and TypeScript types) are
//! produced by `cargo xtask gen-*` from this crate and never hand-edited. The
//! error catalog is generated from core and strategy definitions. This crate
//! forbids error catalog semantics, editor dependencies, transport
//! dependencies, and any knowledge of strategies' target semantics.

pub mod config;
pub mod descriptor;
pub mod error;
pub mod methods;

pub use descriptor::HardwareDescriptor;
pub use error::RpcError;
pub use methods::{InitializeParams, InitializeResult};

/// Protocol version negotiated during the initialize handshake.
pub const PROTOCOL_VERSION: &str = "0.1.0";

/// JSON-RPC method namespace.
pub const METHOD_NAMESPACE: &str = "betelgeuz";

/// Version negotiation: while the protocol is `0.x`, versions must match
/// exactly. A mismatch is returned to the caller rather than silently
/// degrading.
pub fn negotiate(requested: &str) -> Result<String, VersionMismatch> {
    if requested == PROTOCOL_VERSION {
        Ok(PROTOCOL_VERSION.to_string())
    } else {
        Err(VersionMismatch {
            core_version: PROTOCOL_VERSION,
            requested: requested.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionMismatch {
    pub core_version: &'static str,
    pub requested: String,
}

impl std::fmt::Display for VersionMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "core {}, frontend {}", self.core_version, self.requested)
    }
}

impl std::error::Error for VersionMismatch {}

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
        assert_eq!(err.core_version, PROTOCOL_VERSION);
        assert_eq!(err.requested, "9.9.9");
    }
}
