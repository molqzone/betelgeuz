//! `russh`-backed production implementation of [`SshTransport`].
//!
//! This is the single production transport. It verifies the pinned host key
//! before any session is exposed and keeps one SSH session per transport
//! object with independent exec, SFTP, and forwarding channels. Proxy chains
//! are a typed profile feature and land later; until then they fail with
//! `profile.unsupported-proxy` rather than being silently ignored.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use errors::{BetelgeuzError, ErrorCode};
use russh::{
    client::{self, Handler},
    keys::{decode_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, Disconnect, Sig,
};
use russh_sftp::client::SftpSession;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot, watch},
};

use crate::{
    ExecEvent, ExecHandle, ExecRequest, HostKeyFingerprint, OutputStream, RemoteFileInfo,
    SessionLoss, SshConnectOptions, SshEndpoint, SshTransport,
};

/// Records the server key for fingerprinting and accepts the session only when
/// it matches the expected pin. With no expected pin (`inspect_host_key`) it
/// records and rejects.
struct PinningHandler {
    expected: Option<HostKeyFingerprint>,
    observed: Arc<StdMutex<Option<HostKeyFingerprint>>>,
    mismatch: AtomicBool,
}

impl Handler for PinningHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                HostKeyFingerprint::parse(format!("{}", key.fingerprint(russh::keys::HashAlg::Sha256)))
                    .ok()
            }
            // Certificate host keys cannot be pinned to a fingerprint yet.
            PublicKeyOrCertificate::Certificate(_) => None,
        };
        let Some(fingerprint) = fingerprint else {
            self.mismatch.store(true, Ordering::Relaxed);
            return Ok(false);
        };
        *self.observed.lock().unwrap() = Some(fingerprint.clone());
        let accepted = self
            .expected
            .as_ref()
            .map(|pin| pin == &fingerprint)
            .unwrap_or(false);
        if !accepted {
            self.mismatch.store(true, Ordering::Relaxed);
        }
        Ok(accepted)
    }
}

pub struct RusshTransport {
    session: Arc<tokio::sync::Mutex<Option<client::Handle<PinningHandler>>>>,
    sftp: tokio::sync::Mutex<Option<SftpSession>>,
    session_state: watch::Sender<Option<SessionLoss>>,
}

impl RusshTransport {
    pub fn new() -> Self {
        let (session_state, _) = watch::channel(None);
        Self {
            session: Arc::new(tokio::sync::Mutex::new(None)),
            sftp: tokio::sync::Mutex::new(None),
            session_state,
        }
    }

    async fn connected_session(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<client::Handle<PinningHandler>>>, BetelgeuzError>
    {
        let guard = self.session.lock().await;
        if guard.is_some() {
            Ok(guard)
        } else {
            Err(BetelgeuzError::new(ErrorCode::SshLost))
        }
    }

    async fn sftp_session(&self) -> Result<tokio::sync::MutexGuard<'_, Option<SftpSession>>, BetelgeuzError>
    {
        let mut sftp = self.sftp.lock().await;
        if sftp.is_none() {
            let channel = {
                let guard = self.connected_session().await?;
                let handle = guard.as_ref().expect("checked above");
                handle
                    .channel_open_session()
                    .await
                    .map_err(|error| connection_error(error, &self.session_state, true))?
            };
            let session = SftpSession::new(channel.into_stream())
                .await
                .map_err(|error| BetelgeuzError::new(ErrorCode::SshLost).with_cause(error))?;
            *sftp = Some(session);
        }
        Ok(sftp)
    }
}

impl Default for RusshTransport {
    fn default() -> Self {
        Self::new()
    }
}

/// Maps a transport failure to a catalog error and records the loss once.
/// The `detail` is a log adjunct; the catalog code is what the core acts on.
fn connection_error(
    error: impl std::fmt::Display,
    session_state: &watch::Sender<Option<SessionLoss>>,
    lost: bool,
) -> BetelgeuzError {
    if lost {
        session_state.send_replace(Some(SessionLoss {
            cause: ErrorCode::SshLost,
            detail: error.to_string(),
        }));
        BetelgeuzError::new(ErrorCode::SshLost).with_cause(error)
    } else {
        BetelgeuzError::new(ErrorCode::SshUnreachable).with_cause(error)
    }
}

#[async_trait]
impl SshTransport for RusshTransport {
    async fn inspect_host_key(
        &self,
        endpoint: &SshEndpoint,
    ) -> Result<HostKeyFingerprint, BetelgeuzError> {
        let observed: Arc<StdMutex<Option<HostKeyFingerprint>>> = Arc::new(StdMutex::new(None));
        let handler = PinningHandler {
            expected: None,
            observed: Arc::clone(&observed),
            mismatch: AtomicBool::new(false),
        };
        let config = Arc::new(client::Config::default());
        // The probe never accepts the session; the fingerprint is recorded
        // before the handshake is rejected.
        let _ = client::connect(config, (endpoint.host.as_str(), endpoint.port), handler).await;
        let fingerprint = observed.lock().unwrap().clone();
        fingerprint.ok_or_else(|| {
            BetelgeuzError::new(ErrorCode::SshHandshakeFailed)
                .with_detail("the server did not present a pinnable host key")
        })
    }

    async fn connect(&self, options: SshConnectOptions) -> Result<(), BetelgeuzError> {
        if !options.proxy_chain.is_empty() {
            return Err(BetelgeuzError::new(ErrorCode::ProfileUnsupportedProxy)
                .with_detail("proxy chains are not yet implemented in the russh transport"));
        }
        let SshConnectOptions {
            endpoint,
            authentication,
            host_key_pin,
            keepalive_seconds,
            proxy_chain: _,
        } = options;

        let observed: Arc<StdMutex<Option<HostKeyFingerprint>>> = Arc::new(StdMutex::new(None));
        let handler = PinningHandler {
            expected: Some(host_key_pin.clone()),
            observed: Arc::clone(&observed),
            mismatch: AtomicBool::new(false),
        };
        let config = Arc::new(client::Config::default());
        let mut handle =
            client::connect(config, (endpoint.host.as_str(), endpoint.port), handler)
                .await
                .map_err(|error| {
                    if observed.lock().unwrap().is_some() {
                        // The server presented a key that did not match the pin.
                        BetelgeuzError::new(ErrorCode::SshHostkeyMismatch)
                            .with_detail(format!("expected pin {}", host_key_pin.as_str()))
                            .with_cause(error)
                    } else {
                        BetelgeuzError::new(ErrorCode::SshUnreachable).with_cause(error)
                    }
                })?;

        let user = endpoint.username.clone();
        let authenticated = match authentication {
            crate::Authentication::Password(secret) => handle
                .authenticate_password(user, secret.expose().to_owned())
                .await,
            crate::Authentication::PrivateKey {
                private_key,
                passphrase,
            } => {
                let key = decode_secret_key(
                    private_key.expose(),
                    passphrase.as_ref().map(|secret| secret.expose()),
                )
                .map_err(|error| {
                    BetelgeuzError::new(ErrorCode::SshAuthFailed)
                        .with_detail("private key could not be decoded")
                        .with_cause(error)
                })?;
                handle
                    .authenticate_publickey(
                        user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), Some(russh::keys::HashAlg::Sha256)),
                    )
                    .await
            }
        };
        // `AuthResult` is not nameable outside russh; its `success()` is.
        let authenticated = match authenticated {
            Ok(result) => result.success(),
            Err(_) => false,
        };
        if !authenticated {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
            return Err(BetelgeuzError::new(ErrorCode::SshAuthFailed)
                .with_detail("no accepted authentication method for this user"));
        }

        *self.session.lock().await = Some(handle);
        self.spawn_keepalive(keepalive_seconds);
        Ok(())
    }

    fn session_state(&self) -> watch::Receiver<Option<SessionLoss>> {
        self.session_state.subscribe()
    }

    async fn exec(&self, request: ExecRequest) -> Result<ExecHandle, BetelgeuzError> {
        let channel = {
            let guard = self.connected_session().await?;
            let handle = guard.as_ref().expect("checked above");
            handle
                .channel_open_session()
                .await
                .map_err(|error| connection_error(error, &self.session_state, true))?
        };
        channel
            .exec(true, request.command)
            .await
            .map_err(|error| connection_error(error, &self.session_state, true))?;

        let (sender, receiver) = mpsc::channel(16);
        let (terminate, termination) = oneshot::channel();
        tokio::spawn(async move {
            let mut channel = channel;
            let mut terminating: Option<oneshot::Receiver<()>> = Some(termination);
            loop {
                let message = if terminating.is_some() {
                    tokio::select! {
                        biased;
                        _ = terminating.as_mut().expect("checked") => {
                            terminating = None;
                            // Transport-level termination is a polite signal;
                            // escalation is the strategy's job via its recorded
                            // PID handle.
                            let _ = channel.signal(Sig::TERM).await;
                            continue;
                        }
                        message = channel.wait() => message,
                    }
                } else {
                    channel.wait().await
                };
                let event = match message {
                    Some(ChannelMsg::Data { data }) => Some(Ok(ExecEvent::Output {
                        stream: OutputStream::Stdout,
                        bytes: data.to_vec(),
                    })),
                    Some(ChannelMsg::ExtendedData { data, ext }) => {
                        Some(Ok(ExecEvent::Output {
                            stream: if ext == 2 {
                                OutputStream::Stderr
                            } else {
                                OutputStream::Stdout
                            },
                            bytes: data.to_vec(),
                        }))
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => Some(Ok(ExecEvent::Exit {
                        status: Some(exit_status),
                        signal: None,
                    })),
                    Some(ChannelMsg::ExitSignal {
                        signal_name, ..
                    }) => Some(Ok(ExecEvent::Exit {
                        status: None,
                        signal: Some(format!("{signal_name:?}")),
                    })),
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => None,
                    _ => continue,
                };
                match event {
                    Some(event) => {
                        if sender.send(event).await.is_err() {
                            return;
                        }
                    }
                    None => return,
                }
            }
        });
        Ok(ExecHandle::new(receiver, Some(terminate)))
    }

    async fn upload(
        &self,
        source: &mut (dyn AsyncRead + Unpin + Send),
        remote_path: &str,
    ) -> Result<(), BetelgeuzError> {
        let sftp = self.sftp_session().await?;
        let sftp = sftp.as_ref().expect("populated above");
        let mut file = sftp.create(remote_path).await.map_err(|error| {
            BetelgeuzError::new(ErrorCode::DeployUploadFailed).with_cause(error)
        })?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = source.read(&mut buffer).await.map_err(|error| {
                BetelgeuzError::new(ErrorCode::DeployUploadFailed).with_cause(error)
            })?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).await.map_err(|error| {
                BetelgeuzError::new(ErrorCode::DeployUploadFailed).with_cause(error)
            })?;
        }
        file.close().await.map_err(|error| {
            BetelgeuzError::new(ErrorCode::DeployUploadFailed).with_cause(error)
        })?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), BetelgeuzError> {
        let sftp = self.sftp_session().await?;
        let sftp = sftp.as_ref().expect("populated above");
        sftp.rename(from, to).await.map_err(|error| {
            BetelgeuzError::new(ErrorCode::DeployCommitFailed).with_cause(error)
        })
    }

    async fn remove(&self, path: &str) -> Result<(), BetelgeuzError> {
        let sftp = self.sftp_session().await?;
        let sftp = sftp.as_ref().expect("populated above");
        sftp.remove_file(path).await.map_err(|error| {
            BetelgeuzError::new(ErrorCode::DeployCommitFailed).with_cause(error)
        })
    }

    async fn metadata(&self, path: &str) -> Result<Option<RemoteFileInfo>, BetelgeuzError> {
        let sftp = self.sftp_session().await?;
        let sftp = sftp.as_ref().expect("populated above");
        if !sftp.try_exists(path).await.map_err(|error| {
            BetelgeuzError::new(ErrorCode::SshLost).with_cause(error)
        })? {
            return Ok(None);
        }
        let attributes = sftp.metadata(path).await.map_err(|error| {
            BetelgeuzError::new(ErrorCode::SshLost).with_cause(error)
        })?;
        Ok(Some(RemoteFileInfo {
            size: attributes.size.unwrap_or_default(),
            mode: attributes.permissions.unwrap_or_default(),
            is_file: attributes.file_type().is_file(),
        }))
    }

    async fn close(&self) -> Result<(), BetelgeuzError> {
        let mut guard = self.session.lock().await;
        *self.sftp.lock().await = None;
        if let Some(handle) = guard.take() {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
        }
        Ok(())
    }
}

impl RusshTransport {
    /// Periodic keepalive; a failed probe records a lost session so the
    /// core's reconnect policy can take over.
    fn spawn_keepalive(&self, every_seconds: u16) {
        let session = Arc::clone(&self.session);
        let session_state = self.session_state.clone();
        tokio::spawn(async move {
            let interval = Duration::from_secs(u64::from(every_seconds.max(1)));
            loop {
                tokio::time::sleep(interval).await;
                let guard = session.lock().await;
                let Some(handle) = guard.as_ref() else { return };
                if handle.send_keepalive(false).await.is_err() {
                    drop(guard);
                    session_state.send_replace(Some(SessionLoss {
                        cause: ErrorCode::SshLost,
                        detail: "keepalive probe failed".into(),
                    }));
                    return;
                }
            }
        });
    }
}
