//! Single source of truth for the extension/core contract.
//!
//! This crate owns:
//! - the JSON-RPC 2.0 method surface (`betelgeuz/*` names), typed with serde;
//! - the initialize handshake and protocol version negotiation;
//! - the error code catalog (the core error enum documented in `docs/ERRORS.md`);
//! - the configuration schema (`betelgeuz.*` keys) and the hardware descriptor
//!   schema (`/etc/betelgeuz/device.json`).
//!
//! Generated artifacts (JSON Schema, TypeScript types, `docs/ERRORS.md`) are
//! produced by `cargo xtask gen-*` from this crate and never hand-edited.

/// Protocol version negotiated during the initialize handshake.
pub const PROTOCOL_VERSION: &str = "0.1.0";

/// JSON-RPC method namespace.
pub const METHOD_NAMESPACE: &str = "betelgeuz";

// TODO(Phase 0): method list (profile resolution, attach/connect, artifact
// handoff, deploy/lifecycle, logs/status, debug-provider preparation), the
// notification set (connection state, target state, progress, output, errors),
// and the structured error object mapping the error catalog onto JSON-RPC
// error responses.
