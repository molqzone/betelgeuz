//! In-memory SSH transport for core and strategy tests.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Arc, Mutex,
    },
};

use async_trait::async_trait;
use errors::{BetelgeuzError, ErrorCode};
use tokio::{io::AsyncReadExt, sync::broadcast};

use crate::{
    ExecChannel, ExecEvent, ExecRequest, HostKeyFingerprint, PortForward, RemoteFileInfo,
    SessionEvent, SshConnectOptions, SshEndpoint, SshSession, SshTransport,
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
    events: broadcast::Sender<SessionEvent>,
    next_forward_port: AtomicU16,
}

impl FakeSshTransport {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(32);
        Self {
            state: Arc::new(FakeState {
                host_key: Mutex::new(HostKeyFingerprint::parse(DEFAULT_HOST_KEY).unwrap()),
                connect_failure: AtomicBool::new(false),
                connected: AtomicBool::new(false),
                command_events: Mutex::new(HashMap::new()),
                files: Mutex::new(HashMap::new()),
                events,
                next_forward_port: AtomicU16::new(40_000),
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
    pub fn drop_connection(&self, detail: impl Into<String>) {
        self.state.connected.store(false, Ordering::Relaxed);
        let _ = self.state.events.send(SessionEvent::Disconnected {
            detail: detail.into(),
        });
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

    async fn connect(
        &self,
        options: SshConnectOptions,
    ) -> Result<Box<dyn SshSession>, BetelgeuzError> {
        if self.state.connect_failure.load(Ordering::Relaxed) {
            return Err(BetelgeuzError::new(ErrorCode::SshUnreachable));
        }

        if options.host_key_pin != *self.state.host_key.lock().unwrap() {
            return Err(BetelgeuzError::new(ErrorCode::SshHostkeyMismatch));
        }

        self.state.connected.store(true, Ordering::Relaxed);
        Ok(Box::new(FakeSshSession {
            state: Arc::clone(&self.state),
        }))
    }
}

struct FakeSshSession {
    state: Arc<FakeState>,
}

impl FakeSshSession {
    fn ensure_connected(&self) -> Result<(), BetelgeuzError> {
        if self.state.connected.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(BetelgeuzError::new(ErrorCode::SshLost))
        }
    }
}

#[async_trait]
impl SshSession for FakeSshSession {
    fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.state.events.subscribe()
    }

    async fn exec(&self, request: ExecRequest) -> Result<Box<dyn ExecChannel>, BetelgeuzError> {
        self.ensure_connected()?;
        let events = self
            .state
            .command_events
            .lock()
            .unwrap()
            .get(&request.command)
            .cloned()
            .unwrap_or_default();
        Ok(Box::new(FakeExecChannel {
            events: events.into(),
            terminated: false,
            termination_reported: false,
        }))
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

    async fn forward(
        &self,
        _remote_host: &str,
        remote_port: u16,
    ) -> Result<Box<dyn PortForward>, BetelgeuzError> {
        self.ensure_connected()?;
        if remote_port == 0 {
            return Err(BetelgeuzError::new(ErrorCode::ConfigInvalid)
                .with_detail("forward target port must be non-zero"));
        }
        let local_port = self.state.next_forward_port.fetch_add(1, Ordering::Relaxed);
        Ok(Box::new(FakePortForward {
            local_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), local_port),
            closed: false,
        }))
    }

    async fn close(&self) -> Result<(), BetelgeuzError> {
        self.state.connected.store(false, Ordering::Relaxed);
        Ok(())
    }
}

struct FakeExecChannel {
    events: std::collections::VecDeque<ExecEvent>,
    terminated: bool,
    termination_reported: bool,
}

#[async_trait]
impl ExecChannel for FakeExecChannel {
    async fn next_event(&mut self) -> Result<Option<ExecEvent>, BetelgeuzError> {
        if let Some(event) = self.events.pop_front() {
            return Ok(Some(event));
        }
        if self.terminated && !self.termination_reported {
            self.termination_reported = true;
            return Ok(Some(ExecEvent::Exit {
                status: None,
                signal: Some("TERM".into()),
            }));
        }
        Ok(None)
    }

    async fn terminate(&mut self) -> Result<(), BetelgeuzError> {
        self.terminated = true;
        Ok(())
    }
}

struct FakePortForward {
    local_addr: SocketAddr,
    closed: bool,
}

#[async_trait]
impl PortForward for FakePortForward {
    fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    async fn close(&mut self) -> Result<(), BetelgeuzError> {
        self.closed = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Authentication, OutputStream, Secret};

    fn connect_options(pin: &str) -> SshConnectOptions {
        SshConnectOptions {
            endpoint: SshEndpoint {
                host: "board.local".into(),
                port: 22,
                username: "root".into(),
            },
            authentication: Authentication::Password(Secret::new(b"secret".to_vec())),
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
        let session = transport
            .connect(connect_options(DEFAULT_HOST_KEY))
            .await
            .unwrap();
        transport.set_exec_events(
            "fixed-launcher",
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
        let mut command = session
            .exec(ExecRequest {
                command: "fixed-launcher".into(),
                allocate_pty: false,
            })
            .await
            .unwrap();
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
        session.upload(&mut source, "/tmp/stage.elf").await.unwrap();
        session
            .rename("/tmp/stage.elf", "/lib/firmware/app.elf")
            .await
            .unwrap();
        assert_eq!(
            transport.remote_file("/lib/firmware/app.elf").as_deref(),
            Some(&b"firmware"[..])
        );
        assert!(session.metadata("/tmp/stage.elf").await.unwrap().is_none());
    }
}
