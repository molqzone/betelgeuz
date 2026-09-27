//! Core-owned request orchestration.
//!
//! Profile resolution and one-use credential lookup live here. The RPC layer
//! passes typed protocol values to this service and never constructs SSH
//! commands or transport options itself.

use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use errors::{BetelgeuzError, ErrorCode};
use protocol::{
    config::{CredentialSecrets, ProxyHopProfile},
    descriptor::{HardwareDescriptor, VerifiedTargetIdentity},
    methods::{
        AttachRequest, AttachResult, ConnectionState, DisconnectResult, InspectHostKeyParams,
        InspectHostKeyResult, ResolveProfileParams, ResolveProfileResult, ResolvedProfile,
    },
};
use transport::{
    Authentication, HostKeyFingerprint, SshConnectOptions, SshEndpoint, SshProxyHop,
    SshTransport,
};

use crate::profile::{resolve_profile, ResolvedTargetProfile};

#[derive(Debug)]
pub enum CoreRequest {
    ResolveProfile(ResolveProfileParams),
    InspectHostKey(InspectHostKeyParams),
    Attach(AttachRequest),
    Disconnect(protocol::methods::AttachRef),
}

#[derive(Debug)]
pub enum CoreResponse {
    ResolveProfile(ResolveProfileResult),
    InspectHostKey(InspectHostKeyResult),
    Attach(AttachResult),
    Disconnect(DisconnectResult),
}

#[async_trait]
pub trait RequestHandler {
    async fn handle_request(
        &mut self,
        request: CoreRequest,
    ) -> Result<CoreResponse, BetelgeuzError>;
}

pub struct CoreService<T> {
    transport: T,
    attached_id: Option<String>,
    next_attach_id: AtomicU64,
}

impl<T> CoreService<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            attached_id: None,
            next_attach_id: AtomicU64::new(1),
        }
    }
}

#[async_trait]
impl<T> RequestHandler for CoreService<T>
where
    T: SshTransport,
{
    async fn handle_request(
        &mut self,
        request: CoreRequest,
    ) -> Result<CoreResponse, BetelgeuzError> {
        match request {
            CoreRequest::ResolveProfile(params) => {
                let resolved = resolve_profile(&params.catalog, &params.target)?;
                Ok(CoreResponse::ResolveProfile(ResolveProfileResult {
                    profile: public_profile(&resolved),
                }))
            }
            CoreRequest::InspectHostKey(params) => {
                let resolved = resolve_profile(&params.catalog, &params.target)?;
                reject_proxy_chain(&resolved)?;
                let endpoint = endpoint(&resolved);
                let observed = self.transport.inspect_host_key(&endpoint).await?;
                Ok(CoreResponse::InspectHostKey(InspectHostKeyResult {
                    host_key_fingerprint: observed.as_str().to_owned(),
                }))
            }
            CoreRequest::Attach(request) => self.attach(request).await.map(CoreResponse::Attach),
            CoreRequest::Disconnect(request) => {
                if self.attached_id.as_deref() != Some(request.attach_id.as_str()) {
                    return Err(BetelgeuzError::new(ErrorCode::SshLost)
                        .with_detail("attach id is not connected"));
                }
                self.transport.close().await?;
                self.attached_id = None;
                Ok(CoreResponse::Disconnect(DisconnectResult {
                    state: ConnectionState::Disconnected,
                }))
            }
        }
    }
}

impl<T> CoreService<T>
where
    T: SshTransport,
{
    async fn attach(&mut self, request: AttachRequest) -> Result<AttachResult, BetelgeuzError> {
        if self.attached_id.is_some() {
            return Err(BetelgeuzError::new(ErrorCode::DeployBusy)
                .with_detail("another attach is already active"));
        }
        let resolved = resolve_profile(&request.catalog, &request.target)?;
        reject_proxy_chain(&resolved)?;
        let host_key = resolved.host_key.as_deref().ok_or_else(|| {
            BetelgeuzError::new(ErrorCode::SshHostkeyMismatch)
                .with_detail("host-key enrollment required before attach")
        })?;
        let host_key_pin = HostKeyFingerprint::parse(host_key.to_owned())?;
        let endpoint = endpoint(&resolved);

        // Probe first so the core can distinguish an unpinned/mismatched key
        // from an authentication or network failure before opening a session.
        let observed = self.transport.inspect_host_key(&endpoint).await?;
        if observed != host_key_pin {
            return Err(
                BetelgeuzError::new(ErrorCode::SshHostkeyMismatch).with_detail(format!(
                    "expected pin {host_key}, observed {}",
                    observed.as_str()
                )),
            );
        }

        // One-use credential material: values move out of the map, so a
        // reference used twice is an error rather than a silent copy.
        let mut secrets = request.credential_secrets.ok_or_else(|| {
            BetelgeuzError::new(ErrorCode::SshAuthFailed).with_detail(format!(
                "credential material for `{}` was not supplied",
                resolved.credential_ref
            ))
        })?;
        let authentication = password_auth(&mut secrets, &resolved.credential_ref)?;
        let proxy_chain = resolved
            .proxy_chain
            .iter()
            .map(|hop| proxy_options(hop, &mut secrets))
            .collect::<Result<Vec<_>, _>>()?;
        self.transport
            .connect(SshConnectOptions {
                endpoint: endpoint.clone(),
                authentication,
                host_key_pin: host_key_pin.clone(),
                proxy_chain,
                keepalive_seconds: resolved.keepalive_seconds,
            })
            .await?;

        let attach_id = format!(
            "attach-{}",
            self.next_attach_id.fetch_add(1, Ordering::Relaxed)
        );
        self.attached_id = Some(attach_id.clone());
        let profile = public_profile(&resolved);
        let identity = VerifiedTargetIdentity {
            host: resolved.host,
            port: resolved.port,
            host_key_fingerprint: host_key_pin.as_str().to_owned(),
            // Profile identity pins are returned separately. The descriptor is
            // intentionally empty until a verified-session inspection lands.
            descriptor: HardwareDescriptor::default(),
        };
        Ok(AttachResult {
            attach_id,
            state: ConnectionState::Attached,
            profile,
            identity,
            strategy_id: request.strategy_id,
            operations: Vec::new(),
        })
    }
}

fn endpoint(profile: &ResolvedTargetProfile) -> SshEndpoint {
    SshEndpoint {
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
    }
}

fn reject_proxy_chain(profile: &ResolvedTargetProfile) -> Result<(), BetelgeuzError> {
    if profile.proxy_chain.is_empty() {
        Ok(())
    } else {
        Err(BetelgeuzError::new(ErrorCode::ProfileUnsupportedProxy)
            .with_detail("proxy chains are not yet implemented in the russh transport"))
    }
}

fn public_profile(profile: &ResolvedTargetProfile) -> ResolvedProfile {
    ResolvedProfile {
        profile_name: profile.profile_name.clone(),
        host: profile.host.clone(),
        port: profile.port,
        username: profile.username.clone(),
        host_key_pinned: profile.host_key.is_some(),
        device_id: profile.device_id.clone(),
        board_id: profile.board_id.clone(),
        soc_id: profile.soc_id.clone(),
        keepalive_seconds: profile.keepalive_seconds,
        proxy_hops: profile.proxy_chain.len() as u32,
    }
}

fn password_auth(
    secrets: &mut CredentialSecrets,
    credential_ref: &str,
) -> Result<Authentication, BetelgeuzError> {
    let material = secrets.0.remove(credential_ref).ok_or_else(|| {
        BetelgeuzError::new(ErrorCode::SshAuthFailed).with_detail(format!(
            "credential material for `{credential_ref}` was not supplied or was already used"
        ))
    })?;
    let password = material.password.ok_or_else(|| {
        BetelgeuzError::new(ErrorCode::SshAuthFailed)
            .with_detail("only password credentials are available for this attach")
    })?;
    Ok(Authentication::Password(password))
}

fn proxy_options(
    hop: &ProxyHopProfile,
    secrets: &mut CredentialSecrets,
) -> Result<SshProxyHop, BetelgeuzError> {
    let host_key_pin = HostKeyFingerprint::parse(hop.host_key.clone())?;
    Ok(SshProxyHop {
        endpoint: SshEndpoint {
            host: hop.host.clone(),
            port: hop.port,
            username: hop.username.clone(),
        },
        authentication: password_auth(secrets, &hop.credential_ref)?,
        host_key_pin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::config::CredentialMaterial;
    use protocol::config::{ProfileCatalog, TargetOverrides};
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use tokio::io::BufReader;
    use transport::fake::FakeSshTransport;

    const PIN: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn request() -> AttachRequest {
        AttachRequest {
            catalog: ProfileCatalog::default(),
            target: TargetOverrides {
                host: Some("board.local".into()),
                username: Some("root".into()),
                credential_ref: Some("board".into()),
                host_key: Some(PIN.into()),
                ..TargetOverrides::default()
            },
            strategy_id: "linux.ssh-app".into(),
            strategy_configuration: Value::Null,
            credential_secrets: Some(CredentialSecrets(BTreeMap::from([(
                "board".into(),
                CredentialMaterial {
                    password: Some("secret".to_owned().into()),
                    passphrase: None,
                },
            )]))),
        }
    }

    #[tokio::test]
    async fn attach_connects_fake_transport_without_echoing_secret() {
        let mut service = CoreService::new(FakeSshTransport::new());
        let value = service.attach(request()).await.unwrap();
        assert_eq!(value.state, ConnectionState::Attached);
        assert!(!serde_json::to_string(&value).unwrap().contains("secret"));
    }

    #[tokio::test]
    async fn attach_requires_host_key_enrollment() {
        let mut request = request();
        request.target.host_key = None;
        let mut service = CoreService::new(FakeSshTransport::new());
        let error = service.attach(request).await.unwrap_err();
        assert_eq!(error.code, "ssh.hostkey-mismatch");
    }

    #[tokio::test]
    async fn inspect_host_key_returns_candidate_for_enrollment() {
        let request = InspectHostKeyParams {
            catalog: ProfileCatalog::default(),
            target: TargetOverrides {
                host: Some("board.local".into()),
                username: Some("root".into()),
                credential_ref: Some("board".into()),
                host_key: None,
                ..TargetOverrides::default()
            },
        };
        let mut service = CoreService::new(FakeSshTransport::new());
        let response = service
            .handle_request(CoreRequest::InspectHostKey(request))
            .await
            .unwrap();
        let CoreResponse::InspectHostKey(response) = response else {
            panic!("unexpected response");
        };
        assert_eq!(
            response.host_key_fingerprint,
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
    }

    #[tokio::test]
    async fn inspect_host_key_rejects_proxy_before_direct_probe() {
        let request = InspectHostKeyParams {
            catalog: ProfileCatalog::default(),
            target: TargetOverrides {
                host: Some("board.local".into()),
                username: Some("root".into()),
                credential_ref: Some("board".into()),
                proxy_chain: Some(vec![ProxyHopProfile {
                    host: "relay.local".into(),
                    port: 22,
                    username: "root".into(),
                    credential_ref: "relay".into(),
                    host_key: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
                }]),
                ..TargetOverrides::default()
            },
        };
        let mut service = CoreService::new(FakeSshTransport::new());
        let error = service
            .handle_request(CoreRequest::InspectHostKey(request))
            .await
            .unwrap_err();
        assert_eq!(error.code, "profile.unsupported-proxy");
    }

    #[tokio::test]
    async fn attach_rejects_mismatched_host_key_before_connecting() {
        let transport = FakeSshTransport::new();
        transport.set_host_key(
            HostKeyFingerprint::parse("SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
                .unwrap(),
        );
        let mut service = CoreService::new(transport);
        let error = service.attach(request()).await.unwrap_err();
        assert_eq!(error.code, "ssh.hostkey-mismatch");
    }

    #[tokio::test]
    async fn attach_returns_transport_connect_errors() {
        let transport = FakeSshTransport::new();
        transport.set_connect_failure(true);
        let mut service = CoreService::new(transport);
        let error = service.attach(request()).await.unwrap_err();
        assert_eq!(error.code, "ssh.unreachable");
    }

    #[tokio::test]
    async fn rpc_stdio_routes_attach_and_disconnect_through_the_core_service() {
        let mut input = Vec::new();
        crate::rpc::write_message(
            &mut input,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "betelgeuz/attach",
                "params": {
                    "catalog": {},
                    "target": {
                        "host": "board.local",
                        "username": "root",
                        "credentialRef": "board",
                        "hostKey": PIN
                    },
                    "strategyId": "linux.ssh-app",
                    "credentialSecrets": { "board": { "password": "one-use-secret" } }
                }
            }),
        )
        .await
        .unwrap();
        crate::rpc::write_message(
            &mut input,
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "betelgeuz/disconnect",
                "params": { "attachId": "attach-1" }
            }),
        )
        .await
        .unwrap();
        let mut reader = BufReader::new(std::io::Cursor::new(input));
        let mut output = Vec::new();
        let mut service = CoreService::new(FakeSshTransport::new());

        crate::rpc::serve(&mut reader, &mut output, &mut service)
            .await
            .unwrap();

        let mut responses = BufReader::new(std::io::Cursor::new(output));
        let attached = crate::rpc::read_message(&mut responses)
            .await
            .unwrap()
            .unwrap();
        let disconnected = crate::rpc::read_message(&mut responses)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attached["result"]["state"], "attached");
        assert_eq!(disconnected["result"]["state"], "disconnected");
        assert!(!attached.to_string().contains("one-use-secret"));
        assert!(crate::rpc::read_message(&mut responses)
            .await
            .unwrap()
            .is_none());
    }
}
