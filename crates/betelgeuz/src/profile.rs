//! Core-owned resolution of shared target profiles and workspace overrides.
//!
//! This module reads connection settings only. It never loads credential
//! material or trusts descriptor data; the returned credential reference is
//! resolved by the core's credential service, and an unpinned host requires
//! explicit enrollment before target data is read.

use errors::{BetelgeuzError, ErrorCode};
pub use protocol::config::{ProfileCatalog, TargetOverrides};

const DEFAULT_SSH_PORT: u16 = 22;

/// Fully resolved, validated connection settings. `host_key` is absent only
/// when the user must explicitly enroll the server key before connecting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTargetProfile {
    pub profile_name: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credential_ref: String,
    pub host_key: Option<String>,
    pub device_id: Option<String>,
    pub board_id: Option<String>,
    pub soc_id: Option<String>,
    pub keepalive_seconds: u16,
    pub proxy_chain: Vec<protocol::config::ProxyHopProfile>,
}

/// Resolves profile settings without connecting or consulting target metadata.
/// Empty strings are treated as unset so an editor's empty settings do not
/// erase values inherited from a named profile.
pub fn resolve_profile(
    catalog: &ProfileCatalog,
    overrides: &TargetOverrides,
) -> Result<ResolvedTargetProfile, BetelgeuzError> {
    let profile = match overrides
        .profile
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        Some(name) => Some(catalog.profiles.get(name).ok_or_else(|| {
            BetelgeuzError::new(ErrorCode::ProfileUnresolved)
                .with_detail(format!("profile `{name}` was not found"))
        })?),
        None => None,
    };

    let host = select(overrides.host.as_deref(), profile.map(|p| p.host.as_str()))
        .ok_or_else(incomplete_profile)?;
    let username = select(
        overrides.username.as_deref(),
        profile.map(|p| p.username.as_str()),
    )
    .ok_or_else(incomplete_profile)?;
    let credential_ref = select(
        overrides.credential_ref.as_deref(),
        profile.map(|p| p.credential_ref.as_str()),
    )
    .ok_or_else(incomplete_profile)?;

    let port = overrides
        .port
        .or_else(|| profile.map(|p| p.port))
        .unwrap_or(DEFAULT_SSH_PORT);
    if port == 0 {
        return Err(BetelgeuzError::new(ErrorCode::ConfigInvalid)
            .with_detail("SSH port must be between 1 and 65535"));
    }
    if host
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(BetelgeuzError::new(ErrorCode::ConfigInvalid)
            .with_detail("SSH host must not contain whitespace"));
    }
    let keepalive_seconds = overrides
        .keepalive_seconds
        .or_else(|| profile.map(|p| p.keepalive_seconds))
        .unwrap_or(30);
    if keepalive_seconds == 0 {
        return Err(BetelgeuzError::new(ErrorCode::ConfigInvalid)
            .with_detail("SSH keepalive interval must be non-zero"));
    }
    let proxy_chain = overrides
        .proxy_chain
        .clone()
        .or_else(|| profile.map(|p| p.proxy_chain.clone()))
        .unwrap_or_default();
    for hop in &proxy_chain {
        if hop.host.trim().is_empty()
            || hop
                .host
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
            || hop.port == 0
            || hop.username.trim().is_empty()
            || hop.credential_ref.trim().is_empty()
            || hop.host_key.trim().is_empty()
        {
            return Err(BetelgeuzError::new(ErrorCode::ConfigInvalid).with_detail(
                "each SSH proxy hop requires a valid endpoint, credential reference, and host-key pin",
            ));
        }
    }

    Ok(ResolvedTargetProfile {
        profile_name: overrides
            .profile
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(str::to_owned),
        host,
        port,
        username,
        credential_ref,
        host_key: select(
            overrides.host_key.as_deref(),
            profile.and_then(|p| p.host_key.as_deref()),
        ),
        device_id: select(
            overrides.device_id.as_deref(),
            profile.and_then(|p| p.device_id.as_deref()),
        ),
        board_id: select(
            overrides.board_id.as_deref(),
            profile.and_then(|p| p.board_id.as_deref()),
        ),
        soc_id: select(
            overrides.soc_id.as_deref(),
            profile.and_then(|p| p.soc_id.as_deref()),
        ),
        keepalive_seconds,
        proxy_chain,
    })
}

fn select(value: Option<&str>, inherited: Option<&str>) -> Option<String> {
    value
        .filter(|value| !value.trim().is_empty())
        .or_else(|| inherited.filter(|value| !value.trim().is_empty()))
        .map(str::to_owned)
}

fn incomplete_profile() -> BetelgeuzError {
    BetelgeuzError::new(ErrorCode::ProfileUnresolved)
        .with_detail("host, username, and credentialRef must resolve to non-empty values")
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::config::TargetProfile;
    use std::collections::BTreeMap;

    fn profile() -> TargetProfile {
        TargetProfile {
            host: "board.local".into(),
            port: 2222,
            username: "root".into(),
            credential_ref: "board-key".into(),
            host_key: Some("SHA256:host-pin".into()),
            device_id: Some("board-1".into()),
            board_id: None,
            soc_id: Some("rk3506".into()),
            keepalive_seconds: 15,
            proxy_chain: Vec::new(),
        }
    }

    #[test]
    fn workspace_values_override_profile_and_blank_values_inherit() {
        let catalog = ProfileCatalog {
            profiles: BTreeMap::from([("board".into(), profile())]),
        };
        let resolved = resolve_profile(
            &catalog,
            &TargetOverrides {
                profile: Some("board".into()),
                host: Some("192.168.7.1".into()),
                username: Some("".into()),
                board_id: Some("revision-a".into()),
                ..TargetOverrides::default()
            },
        )
        .unwrap();

        assert_eq!(resolved.host, "192.168.7.1");
        assert_eq!(resolved.port, 2222);
        assert_eq!(resolved.username, "root");
        assert_eq!(resolved.board_id.as_deref(), Some("revision-a"));
        assert_eq!(resolved.device_id.as_deref(), Some("board-1"));
        assert_eq!(resolved.keepalive_seconds, 15);
        assert!(resolved.proxy_chain.is_empty());
    }

    #[test]
    fn inline_target_can_resolve_without_a_named_profile() {
        let resolved = resolve_profile(
            &ProfileCatalog::default(),
            &TargetOverrides {
                host: Some("192.168.7.1".into()),
                username: Some("root".into()),
                credential_ref: Some("secret-storage:board".into()),
                ..TargetOverrides::default()
            },
        )
        .unwrap();

        assert_eq!(resolved.port, DEFAULT_SSH_PORT);
        assert!(resolved.host_key.is_none());
        assert_eq!(resolved.credential_ref, "secret-storage:board");
        assert_eq!(resolved.keepalive_seconds, 30);
    }

    #[test]
    fn proxy_chain_and_keepalive_are_inherited_and_can_be_overridden() {
        let mut target_profile = profile();
        target_profile
            .proxy_chain
            .push(protocol::config::ProxyHopProfile {
                host: "jump.local".into(),
                port: 22,
                username: "relay".into(),
                credential_ref: "relay-key".into(),
                host_key: "SHA256:relay-pin".into(),
            });
        let catalog = ProfileCatalog {
            profiles: BTreeMap::from([("board".into(), target_profile)]),
        };
        let inherited = resolve_profile(
            &catalog,
            &TargetOverrides {
                profile: Some("board".into()),
                ..TargetOverrides::default()
            },
        )
        .unwrap();
        assert_eq!(inherited.proxy_chain.len(), 1);
        assert_eq!(inherited.keepalive_seconds, 15);

        let overridden = resolve_profile(
            &catalog,
            &TargetOverrides {
                profile: Some("board".into()),
                proxy_chain: Some(Vec::new()),
                keepalive_seconds: Some(45),
                ..TargetOverrides::default()
            },
        )
        .unwrap();
        assert!(overridden.proxy_chain.is_empty());
        assert_eq!(overridden.keepalive_seconds, 45);
    }

    #[test]
    fn proxy_hops_require_a_pinned_credential_reference() {
        let error = resolve_profile(
            &ProfileCatalog::default(),
            &TargetOverrides {
                host: Some("board.local".into()),
                username: Some("root".into()),
                credential_ref: Some("board".into()),
                proxy_chain: Some(vec![protocol::config::ProxyHopProfile {
                    host: "jump.local".into(),
                    port: 22,
                    username: "relay".into(),
                    credential_ref: "".into(),
                    host_key: "".into(),
                }]),
                ..TargetOverrides::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "config.invalid");
    }

    #[test]
    fn catalog_matches_the_value_shape_of_profiles_setting() {
        let catalog = ProfileCatalog {
            profiles: BTreeMap::from([("board".into(), profile())]),
        };
        let json = serde_json::to_value(&catalog).unwrap();
        assert!(json.get("board").is_some());
        assert!(json.get("profiles").is_none());

        let decoded: ProfileCatalog = serde_json::from_value(json).unwrap();
        assert_eq!(decoded, catalog);
    }

    #[test]
    fn unknown_profile_and_invalid_port_fail_as_configuration_errors() {
        let missing = resolve_profile(
            &ProfileCatalog::default(),
            &TargetOverrides {
                profile: Some("missing".into()),
                ..TargetOverrides::default()
            },
        )
        .unwrap_err();
        assert_eq!(missing.code, "profile.unresolved");

        let invalid_port = resolve_profile(
            &ProfileCatalog::default(),
            &TargetOverrides {
                host: Some("board.local".into()),
                port: Some(0),
                username: Some("root".into()),
                credential_ref: Some("key".into()),
                ..TargetOverrides::default()
            },
        )
        .unwrap_err();
        assert_eq!(invalid_port.code, "config.invalid");
    }
}
