//! `betelgeuz-core`: the headless control core.
//!
//! Spawned by an editor frontend (the VS Code adapter first), it speaks a
//! versioned JSON-RPC 2.0 protocol over stdio and owns everything that is not
//! editor API surface: profile resolution, the SSH session, identity
//! verification, the attach state machine, the shared deploy pipeline, and the
//! strategy registry. The core never invokes a build command and never depends
//! on a particular editor.

use protocol::{METHOD_NAMESPACE, PROTOCOL_VERSION};

fn main() {
    // TODO(Phase 0): stdio JSON-RPC server — initialize/version negotiation,
    // request dispatch, notifications, cancellation, structured errors.
    println!("{METHOD_NAMESPACE} core {PROTOCOL_VERSION} (JSON-RPC server not implemented yet)");
}
