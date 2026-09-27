//! In-memory SSH transport for core and strategy tests.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use async_trait::async_trait;
use errors::{BetelgeuzError, ErrorCode};

use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, oneshot, watch},
};

use crate::{
    ExecEvent, ExecHandle, ExecRequest, HostKeyFingerprint, RemoteFileInfo, SessionLoss,
    SshConnectOptions, SshEndpoint, SshTransport,
};

const DEFAULT_HOST_KEY: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[derive(Clone)]
pub struct FakeSshTransport {
    state: Arc<FakeState>,
}

struct FakeState {
    host_key: Mutex<HostKeyFingerprint>,
    connect_failure: AtomicBool,
    connected: AtomicBool,
    command_events: Mutex<HashMap<String, Vec<ExecEvent>>>,
    files: Mutex<HashMap<String, Vec<u8>>>,
    session_state: watch::Sender<Option<SessionLoss>>,
}

impl FakeSshTransport {
    pub fn new() -> Self {
        let (session_state, _) = watch::channel(None);
        Self {
            state: Arc::new(FakeState {
                host_key: Mutex::new(HostKeyFingerprint::parse(DEFAULT_HOST_KEY).unwrap()),
                connect_failure: AtomicBool::new(false),
                connected: AtomicBool::new(false),
                command_events: Mutex::new(HashMap::new()),
                files: Mutex::new(HashMap::new()),
                session_state,
            }),
        }
    }

    pub fn set_host_key(&self, host_key: HostKeyFingerprint) {
        *self.state.host_key.lock().unwrap() = host_key;
    }

    pub fn set_connect_failure(&self, fail: bool) {
        self.state.connect_failure.store(fail, Ordering::Relaxed);
    }

    pub fn set_exec_events(&self, command: impl Into<String>, events: Vec<ExecEvent>) {
        self.state
            .command_events
            .lock()
            .unwrap()
            .insert(command.into(), events);
    }

    pub fn remote_file(&self, path: &str) -> Option<Vec<u8>> {
        self.state.files.lock().unwrap().get(path).cloned()
    }

    /// Simulates an established session dropping so consumers can exercise
    /// their own reconnect policy.
    pub fn drop_connection(&self, cause: ErrorCode, detail: impl Into<String>) {
        self.state.connected.store(false, Ordering::Relaxed);
        self.state.session_state.send_replace(Some(SessionLoss {
            cause,
            detail: detail.into(),
        }));
    }

    fn ensure_connected(&self) -> Result<(), BetelgeuzError> {
        if self.state.connected.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(BetelgeuzError::new(ErrorCode::SshLost))
        }
    }
}

impl Default for FakeSshTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SshTransport for FakeSshTransport {
    async fn inspect_host_key(
        &self,
        _endpoint: &SshEndpoint,
    ) -> Result<HostKeyFingerprint, BetelgeuzError> {
        Ok(self.state.host_key.lock().unwrap().clone())
    }

    async fn connect(&self, options: SshConnectOptions) -> Result<(), BetelgeuzError> {
        if self.state.connect_failure.load(Ordering::Relaxed) {
            return Err(BetelgeuzError::new(ErrorCode::SshUnreachable));
        }

        if options.host_key_pin != *self.state.host_key.lock().unwrap() {
            return Err(BetelgeuzError::new(ErrorCode::SshHostkeyMismatch));
        }

        self.state.connected.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn session_state(&self) -> watch::Receiver<Option<SessionLoss>> {
        self.state.session_state.subscribe()
    }

    async fn exec(&self, request: ExecRequest) -> Result<ExecHandle, BetelgeuzError> {
        self.ensure_connected()?;
        let events = self
            .state
            .command_events
            .lock()
            .unwrap()
            .get(request.command())
            .cloned()
            .unwrap_or_default();
        let (sender, receiver) = mpsc::channel(16);
        let (terminate, termination) = oneshot::channel();
        tokio::spawn(async move {
            for event in events {
                if sender.send(Ok(event)).await.is_err() {
                    return;
                }
            }
            if termination.await.is_ok() {
                let _ = sender
                    .send(Ok(ExecEvent::Exit {
                        status: None,
                        signal: Some("TERM".into()),
                    }))
                    .await;
            }
        });
        Ok(ExecHandle::new(receiver, Some(terminate)))
    }

    async fn upload(
        &self,
        source: &mut (dyn tokio::io::AsyncRead + Unpin + Send),
        remote_path: &str,
    ) -> Result<(), BetelgeuzError> {
        self.ensure_connected()?;
        let mut contents = Vec::new();
        source.read_to_end(&mut contents).await.map_err(|error| {
            BetelgeuzError::new(ErrorCode::DeployUploadFailed).with_cause(error)
        })?;
        self.state
            .files
            .lock()
            .unwrap()
            .insert(remote_path.to_owned(), contents);
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), BetelgeuzError> {
        self.ensure_connected()?;
        let mut files = self.state.files.lock().unwrap();
        let contents = files.remove(from).ok_or_else(|| {
            BetelgeuzError::new(ErrorCode::DeployCommitFailed)
                .with_detail(format!("remote source `{from}` does not exist"))
        })?;
        files.insert(to.to_owned(), contents);
        Ok(())
    }

    async fn remove(&self, path: &str) -> Result<(), BetelgeuzError> {
        self.ensure_connected()?;
        self.state.files.lock().unwrap().remove(path);
        Ok(())
    }

    async fn metadata(&self, path: &str) -> Result<Option<RemoteFileInfo>, BetelgeuzError> {
        self.ensure_connected()?;
        Ok(self
            .state
            .files
            .lock()
            .unwrap()
            .get(path)
            .map(|contents| RemoteFileInfo {
                size: contents.len() as u64,
                mode: 0o644,
                is_file: true,
            }))
    }

    async fn close(&self) -> Result<(), BetelgeuzError> {
        self.state.connected.store(false, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Authentication, FixedCommand, LaunchRequest, OutputStream, TerminateSignal};
    use protocol::config::SensitiveString;

    fn connect_options(pin: &str) -> SshConnectOptions {
        SshConnectOptions {
            endpoint: SshEndpoint {
                host: "board.local".into(),
                port: 22,
                username: "root".into(),
            },
            authentication: Authentication::Password(SensitiveString::from("secret".to_owned())),
            host_key_pin: HostKeyFingerprint::parse(pin).unwrap(),
            proxy_chain: Vec::new(),
            keepalive_seconds: 30,
        }
    }

    #[tokio::test]
    async fn refuses_a_session_when_the_host_key_pin_does_not_match() {
        let transport = FakeSshTransport::new();
        let result = transport
            .connect(connect_options(
                "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            ))
            .await;
        assert!(matches!(result, Err(error) if error.code == "ssh.hostkey-mismatch"));
    }

    #[tokio::test]
    async fn supports_streaming_exec_and_atomic_file_operations() {
        let transport = FakeSshTransport::new();
        transport
            .connect(connect_options(DEFAULT_HOST_KEY))
            .await
            .unwrap();
        let request = ExecRequest::launch(LaunchRequest {
            executable: "fixed-launcher".into(),
            argv: Vec::new(),
            cwd: None,
            environment: Default::default(),
            allocate_pty: false,
        })
        .unwrap();
        transport.set_exec_events(
            request.command().to_owned(),
            vec![
                ExecEvent::Output {
                    stream: OutputStream::Stdout,
                    bytes: b"ready".to_vec(),
                },
                ExecEvent::Exit {
                    status: Some(0),
                    signal: None,
                },
            ],
        );
        let mut command = transport.exec(request).await.unwrap();
        assert!(matches!(
            command.next_event().await.unwrap(),
            Some(ExecEvent::Output { .. })
        ));
        assert!(matches!(
            command.next_event().await.unwrap(),
            Some(ExecEvent::Exit {
                status: Some(0),
                ..
            })
        ));

        let mut source: &[u8] = b"firmware";
        transport.upload(&mut source, "/tmp/stage.elf").await.unwrap();
        transport
            .rename("/tmp/stage.elf", "/lib/firmware/app.elf")
            .await
            .unwrap();
        assert_eq!(
            transport.remote_file("/lib/firmware/app.elf").as_deref(),
            Some(&b"firmware"[..])
        );
        assert!(transport.metadata("/tmp/stage.elf").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn fixed_templates_run_through_the_same_exec_channel() {
        let transport = FakeSshTransport::new();
        transport
            .connect(connect_options(DEFAULT_HOST_KEY))
            .await
            .unwrap();
        let request = ExecRequest::fixed(FixedCommand::SignalProcessGroup {
            pgid: 4242,
            signal: TerminateSignal::Kill,
        });
        assert_eq!(request.command(), "kill -KILL -- -4242");
        transport
            .set_exec_events(request.command().to_owned(), Vec::new());
        let mut handle = transport.exec(request).await.unwrap();
        // The stream stays open while the remote command runs; termination
        // reports the terminating signal and closes it.
        handle.terminate().await.unwrap();
        assert!(matches!(
            handle.next_event().await.unwrap(),
            Some(ExecEvent::Exit {
                signal: Some(signal),
                ..
            }) if signal == "TERM"
        ));
        assert!(handle.next_event().await.unwrap().is_none());
    }
}
