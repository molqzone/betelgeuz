//! Single source of truth for the extension/core contract.
//!
//! This crate owns:
//! - the JSON-RPC 2.0 method surface ([`methods`]), including LSP control
//!   notifications for request cancellation and progress;
//! - the initialize handshake's protocol version constant (negotiation itself
//!   is frontend/core glue and lives in the core's dispatch layer;
//! - the JSON-RPC error wire envelope ([`error::RpcError`]);
//! - the hardware descriptor schema ([`descriptor`]);
//! - the configuration key surface ([`config`]).
//!
//! Generated protocol artifacts (JSON Schema and TypeScript types) are
//! produced by `cargo xtask gen-*` from this crate and strategy-owned
//! configuration metadata and never hand-edited. The error catalog is
//! generated from core and strategy definitions. This crate
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

/// Maximum JSON body size accepted for one stdio message. Artifact contents
/// are never sent through this channel.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// JSON-RPC method namespace.
pub const METHOD_NAMESPACE: &str = "betelgeuz";
