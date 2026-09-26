//! SSH session API shared by core services and deploy strategies.
//!
//! The core owns profile resolution, credential lookup, and reconnect policy.
//! This crate verifies the pinned server key before returning a connected
//! session and provides exec, SFTP, and port-forward channels over that one
//! session. The planned production implementation is `russh`; the fake is
//! available only to tests and test utilities.
//!
//! Abstraction policy: one trait today. It grows, and may split into more
//! focused traits, only when a second implementation or real concurrency
//! forces it.

use std::net::SocketAddr;

use async_trait::async_trait;
use errors::{BetelgeuzError, ErrorCode};
use tokio::{
    io::AsyncRead,
    sync::{broadcast, mpsc, oneshot},
};
use zeroize::Zeroize;

#[cfg(any(test, feature = "test-util"))]
pub mod fake;

/// SSH endpoint data after core-owned profile resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshEndpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
}

/// SHA-256 fingerprint of an SSH server key, in OpenSSH display form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyFingerprint(String);

impl HostKeyFingerprint {
    pub fn parse(value: impl Into<String>) -> Result<Self, BetelgeuzError> {
        let value = value.into();
        let encoded = value.strip_prefix("SHA256:").unwrap_or_default();
        let valid_base64 = encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/');
        if encoded.len() != 43 || !valid_base64 {
            return Err(BetelgeuzError::new(ErrorCode::ConfigInvalid)
                .with_detail("host-key pin must be a SHA256 fingerprint"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Secret bytes are zeroized when dropped and omitted from debug output.
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(value: impl Into<Vec<u8>>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Authentication material resolved from a protected credential reference.
#[derive(Debug)]
pub enum Authentication {
    Password(Secret),
    PrivateKey {
        private_key: Secret,
        passphrase: Option<Secret>,
    },
}

/// A typed SSH jump-host hop. Arbitrary proxy commands are intentionally not
/// part of the transport API.
#[derive(Debug)]
pub struct SshProxyHop {
    pub endpoint: SshEndpoint,
    pub authentication: Authentication,
    pub host_key_pin: HostKeyFingerprint,
}

/// Inputs required to open one SSH session. A target pin is mandatory; host-key
/// enrollment is performed separately before connecting.
#[derive(Debug)]
pub struct SshConnectOptions {
    pub endpoint: SshEndpoint,
    pub authentication: Authentication,
    pub host_key_pin: HostKeyFingerprint,
    pub proxy_chain: Vec<SshProxyHop>,
    pub keepalive_seconds: u16,
}

/// An internal, fixed command with values encoded by its caller. Free-form
/// shell commands are not part of the frontend protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecRequest {
    pub command: String,
    pub allocate_pty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecEvent {
    Output {
        stream: OutputStream,
        bytes: Vec<u8>,
    },
    Exit {
        status: Option<u32>,
        signal: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteFileInfo {
    pub size: u64,
    pub mode: u32,
    pub is_file: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Disconnected { detail: String },
}

/// Streaming result of one exec command. The event stream ends after the exit
/// event; dropping the handle detaches from the remote command.
pub struct ExecHandle {
    events: mpsc::Receiver<Result<ExecEvent, BetelgeuzError>>,
    terminate: Option<oneshot::Sender<()>>,
}

impl ExecHandle {
    /// For implementations of [`SshTransport`].
    pub fn new(
        events: mpsc::Receiver<Result<ExecEvent, BetelgeuzError>>,
        terminate: Option<oneshot::Sender<()>>,
    ) -> Self {
        Self {
            events,
            terminate,
        }
    }

    pub async fn next_event(&mut self) -> Result<Option<ExecEvent>, BetelgeuzError> {
        match self.events.recv().await {
            None => Ok(None),
            Some(Ok(event)) => Ok(Some(event)),
            Some(Err(error)) => Err(error),
        }
    }

    /// Requests termination; the terminating signal arrives as the final exit
    /// event when the implementation observes it.
    pub async fn terminate(&mut self) -> Result<(), BetelgeuzError> {
        if let Some(terminate) = self.terminate.take() {
            let _ = terminate.send(());
        }
        Ok(())
    }
}

/// One local listener forwarded through the SSH session.
pub struct ForwardHandle {
    local_addr: SocketAddr,
    close: Option<oneshot::Sender<()>>,
}

impl ForwardHandle {
    /// For implementations of [`SshTransport`].
    pub fn new(local_addr: SocketAddr, close: Option<oneshot::Sender<()>>) -> Self {
        Self { local_addr, close }
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn close(&mut self) -> Result<(), BetelgeuzError> {
        if let Some(close) = self.close.take() {
            let _ = close.send(());
        }
        Ok(())
    }
}

/// One connected SSH session. `connect` is part of the same object so the core
/// holds exactly one transport per session; connection-loss events arrive on
/// `subscribe`, and reconnect attempts are owned by the core.
#[async_trait]
pub trait SshTransport: Send + Sync {
    /// Reads the server key only. The caller must obtain explicit user
    /// approval before persisting the returned fingerprint as a new pin.
    async fn inspect_host_key(
        &self,
        endpoint: &SshEndpoint,
    ) -> Result<HostKeyFingerprint, BetelgeuzError>;

    /// Establishes the session only after the server key matches
    /// `host_key_pin`.
    async fn connect(&self, options: SshConnectOptions) -> Result<(), BetelgeuzError>;

    /// Receives connection-loss events.
    fn subscribe(&self) -> broadcast::Receiver<SessionEvent>;

    /// Opens a dedicated exec channel on this SSH session.
    async fn exec(&self, request: ExecRequest) -> Result<ExecHandle, BetelgeuzError>;

    /// Uploads through SFTP from a host-side stream, without buffering the
    /// entire artifact in memory.
    async fn upload(
        &self,
        source: &mut (dyn AsyncRead + Unpin + Send),
        remote_path: &str,
    ) -> Result<(), BetelgeuzError>;

    async fn rename(&self, from: &str, to: &str) -> Result<(), BetelgeuzError>;
    async fn remove(&self, path: &str) -> Result<(), BetelgeuzError>;
    async fn metadata(&self, path: &str) -> Result<Option<RemoteFileInfo>, BetelgeuzError>;

    /// Opens a local listener forwarded through this SSH session.
    async fn forward(
        &self,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<ForwardHandle, BetelgeuzError>;

    async fn close(&self) -> Result<(), BetelgeuzError>;
}
