//! `betelgeuz-core`: the headless control core.
//!
//! Spawned by an editor frontend (the VS Code adapter first), it speaks a
//! versioned JSON-RPC 2.0 protocol over stdio and owns everything that is not
//! editor API surface: profile resolution, the SSH session, identity
//! verification, the attach state machine, the shared deploy pipeline, and the
//! strategy registry. The core never invokes a build command and never depends
//! on a particular editor.

pub mod profile;
mod rpc;

use std::io::{self, BufReader};

use protocol::METHOD_NAMESPACE;

fn main() {
    eprintln!(
        "{METHOD_NAMESPACE} core {} starting (stdio JSON-RPC)",
        protocol::PROTOCOL_VERSION
    );
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();
    if let Err(e) = rpc::serve(&mut reader, &mut writer) {
        eprintln!("betelgeuz-core: transport failure: {e}");
        std::process::exit(1);
    }
}
