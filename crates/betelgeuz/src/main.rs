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
mod service;

use protocol::METHOD_NAMESPACE;
use service::CoreService;
use transport::russh_transport::RusshTransport;

#[tokio::main]
async fn main() {
    eprintln!(
        "{METHOD_NAMESPACE} core {} starting (stdio JSON-RPC)",
        protocol::PROTOCOL_VERSION
    );
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = tokio::io::BufReader::new(stdin);
    let mut writer = tokio::io::BufWriter::new(stdout);
    let mut service = CoreService::new(RusshTransport::new());
    if let Err(e) = rpc::serve(&mut reader, &mut writer, &mut service).await {
        eprintln!("betelgeuz-core: transport failure: {e}");
        std::process::exit(1);
    }
}
