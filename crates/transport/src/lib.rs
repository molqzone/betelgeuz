//! Target session API shared by core services and deploy strategies.
//!
//! The core owns profile resolution, credential lookup, and reconnect policy.
//! This crate verifies the pinned server key before returning a connected
//! session and provides exec, SFTP, and forwarding channels over that one
//! session. The single production implementation is `russh` (`russh_transport`);
//! the fake is available only to tests and test utilities.
//!
//! Why wrap `russh` at all — the abstraction policy asks for this justification:
//!
//! - **Pin-first identity.** `inspect_host_key` → explicit user approval →
//!   `connect` with a mandatory pin is a Betelgeuz shape that no library's
//!   known-hosts helpers express.
//! - **Secret handling.** Zeroizing, redacted, move-only secret values are a
//!   plan hard requirement; `russh` takes `&str`/`Vec<u8>` and can make no such
//!   guarantee.
//! - **Churn absorption.** `russh` minor releases move API surface — channel and
//!   stream shapes, the `AuthResult` export, and the crypto backend (ring vs
//!   aws-lc-rs) all shifted while this implementation was written — and SFTP
//!   lives in the separately versioned `russh-sftp`.
//! - **Testability.** The fake transport lets core and strategies run without
//!   hardware or an SSH server.
//!
//! Abstraction policy: one trait today. It grows, and may split into more
//! focused traits, only when a second implementation or real concurrency
//! forces it — never into a speculatively layered trait hierarchy.

use std::collections::BTreeMap;

use async_trait::async_trait;
use errors::{BetelgeuzError, ErrorCode};
use protocol::config::SensitiveString;
use tokio::{
    io::AsyncRead,
    sync::{mpsc, oneshot, watch},
};

#[cfg(any(test, feature = "test-util"))]
pub mod fake;
pub mod russh_transport;

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

/// Authentication material resolved from a protected credential reference.
/// Values are move-only `SensitiveString` secrets: every copy zeroizes on drop
/// and never appears in debug output.
#[derive(Debug)]
pub enum Authentication {
    Password(SensitiveString),
    PrivateKey {
        private_key: SensitiveString,
        passphrase: Option<SensitiveString>,
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

/// A structured launch: what to run and where, never how to spell it. The
/// transport renders this through a fixed encoder; free-form shell lines are
/// not constructible.
#[derive(Debug)]
pub struct LaunchRequest {
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    /// Environment values are secrets by plan rule; they are zeroized with the
    /// rest of the request's secret material.
    pub environment: BTreeMap<String, SensitiveString>,
    pub allocate_pty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminateSignal {
    Term,
    Kill,
}

/// The fixed, zero-interpolation command templates the core uses against the
/// target. Values are typed here and encoded by `ExecRequest::fixed`; callers
/// never concatenate command strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixedCommand {
    /// `kill -<signal> -- -<pgid>` against a process group recorded earlier.
    SignalProcessGroup { pgid: u32, signal: TerminateSignal },
}

/// One exec command. Construct it through [`ExecRequest::launch`] or
/// [`ExecRequest::fixed`]; the rendered command string is not part of the
/// public surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecRequest {
    command: String,
    allocate_pty: bool,
}

impl ExecRequest {
    pub fn launch(launch: LaunchRequest) -> Result<Self, BetelgeuzError> {
        for (field, value) in [
            ("executable", launch.executable.as_str()),
            ("cwd", launch.cwd.as_deref().unwrap_or_default()),
        ] {
            reject_nul(field, value)?;
        }
        for argument in &launch.argv {
            reject_nul("argument", argument)?;
        }
        for (name, value) in &launch.environment {
            validate_env_name(name)?;
            reject_nul("environment value", value.expose())?;
        }

        let mut command = String::new();
        if let Some(cwd) = &launch.cwd {
            command.push_str(&format!("cd {} && ", shell_quote(cwd)));
        }
        for (name, value) in &launch.environment {
            command.push_str(&format!("{}={} ", name, shell_quote(value.expose())));
        }
        command.push_str("exec ");
        command.push_str(&shell_quote(&launch.executable));
        for argument in &launch.argv {
            command.push(' ');
            command.push_str(&shell_quote(argument));
        }
        Ok(Self {
            command,
            allocate_pty: launch.allocate_pty,
        })
    }

    pub fn fixed(template: FixedCommand) -> Self {
        match template {
            FixedCommand::SignalProcessGroup { pgid, signal } => Self {
                command: format!("kill -{} -- -{pgid}", signal.name()),
                allocate_pty: false,
            },
        }
    }

    /// The rendered command line, for transport implementations only.
    pub fn command(&self) -> &str {
        &self.command
    }

    pub fn allocate_pty(&self) -> bool {
        self.allocate_pty
    }
}

impl TerminateSignal {
    fn name(self) -> &'static str {
        match self {
            TerminateSignal::Term => "TERM",
            TerminateSignal::Kill => "KILL",
        }
    }
}

fn reject_nul(field: &str, value: &str) -> Result<(), BetelgeuzError> {
    if value.contains('\0') {
        return Err(BetelgeuzError::new(ErrorCode::ConfigInvalid)
            .with_detail(format!("{field} must not contain NUL bytes")));
    }
    Ok(())
}

/// Environment names are emitted unquoted into assignment position, so they
/// must be shell identifiers rather than arbitrary strings.
fn validate_env_name(name: &str) -> Result<(), BetelgeuzError> {
    let mut characters = name.chars();
    let valid = matches!(characters.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && characters.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid {
        Ok(())
    } else {
        Err(BetelgeuzError::new(ErrorCode::ConfigInvalid)
            .with_detail("environment names must be shell identifiers"))
    }
}

/// POSIX single-quote encoding: everything except `'` is literal inside the
/// quotes; embedded quotes are closed, escaped, and reopened.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
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

/// Connection-loss report. `detail` is a log adjunct and is never parsed; the
/// `cause` is a catalog code so the core maps losses without sniffing text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLoss {
    pub cause: ErrorCode,
    pub detail: String,
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
    /// event when the implementation observes it. Transport-level termination
    /// is a polite signal only — escalation to `SIGKILL` is the strategy's job
    /// via its recorded process-group handle.
    pub async fn terminate(&mut self) -> Result<(), BetelgeuzError> {
        if let Some(terminate) = self.terminate.take() {
            let _ = terminate.send(());
        }
        Ok(())
    }
}

/// One connected session. `connect` is part of the same object so the core
/// holds exactly one transport per session.
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

    /// Connection-loss state, consumed by the core's reconnect policy.
    fn session_state(&self) -> watch::Receiver<Option<SessionLoss>>;

    /// Opens a dedicated exec channel on this session.
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

    async fn close(&self) -> Result<(), BetelgeuzError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_renders_encoded_arguments_and_environment() {
        let mut environment = BTreeMap::new();
        environment.insert("MODE".to_owned(), SensitiveString::from("it's a test".to_owned()));
        let request = ExecRequest::launch(LaunchRequest {
            executable: "/opt/my app".into(),
            argv: vec!["--name=bob's".into()],
            cwd: Some("/opt".into()),
            environment,
            allocate_pty: false,
        })
        .unwrap();
        assert_eq!(
            request.command(),
            r#"cd '/opt' && MODE='it'\''s a test' exec '/opt/my app' '--name=bob'\''s'"#
        );
    }

    #[test]
    fn launch_rejects_nul_bytes() {
        let error = ExecRequest::launch(LaunchRequest {
            executable: "bad\0name".into(),
            argv: Vec::new(),
            cwd: None,
            environment: BTreeMap::new(),
            allocate_pty: false,
        })
        .unwrap_err();
        assert_eq!(error.code, "config.invalid");
    }

    #[test]
    fn fixed_templates_encode_typed_values() {
        let request = ExecRequest::fixed(FixedCommand::SignalProcessGroup {
            pgid: 4242,
            signal: TerminateSignal::Term,
        });
        assert_eq!(request.command(), "kill -TERM -- -4242");
    }
}
