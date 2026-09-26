//! The error catalog: the single source of truth for error semantics.
//!
//! Backends and services fail with [`BetelgeuzError`] values and never with
//! free-form user-facing text. A frontend maps the catalog code to a uniform
//! message and one remediation action. `docs/ERRORS.md` is generated from this
//! catalog (`cargo xtask gen-errors`) and is never hand-edited.

use std::fmt;

use serde::Serialize;

/// Where the failure happened; drives the phase label shown to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Profile,
    Config,
    Connect,
    Identity,
    Inspect,
    Artifact,
    Deploy,
    Lifecycle,
    Logs,
    Debug,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Profile => "profile",
            Phase::Config => "config",
            Phase::Connect => "connect",
            Phase::Identity => "identity",
            Phase::Inspect => "inspect",
            Phase::Artifact => "artifact",
            Phase::Deploy => "deploy",
            Phase::Lifecycle => "lifecycle",
            Phase::Logs => "logs",
            Phase::Debug => "debug",
        }
    }
}

/// The remediation action a frontend offers alongside the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remediation {
    CheckProfileSettings,
    FixProxySettings,
    OpenSettings,
    CheckNetworkAndSshService,
    CheckCredentials,
    CheckAlgorithms,
    CheckHostKeyPin,
    Retry,
    RetryLater,
    CheckIdentityPins,
    RebindAttach,
    BuildWithCMakeTools,
    CheckArtifactToolchain,
    DeploySingleArtifact,
    CheckPrivileges,
    ReclassifyWorkspace,
    RestorePreviousVersion,
    InspectTrace,
    InstallGdbserver,
    InstallDebugAdapter,
    UpgradeFrontend,
    ShowLog,
    None,
}

impl Remediation {
    pub fn as_str(self) -> &'static str {
        match self {
            Remediation::CheckProfileSettings => "check the Betelgeuz profile settings",
            Remediation::FixProxySettings => "fix the profile's proxy settings",
            Remediation::OpenSettings => "open settings at the offending key",
            Remediation::CheckNetworkAndSshService => "check network and SSH service",
            Remediation::CheckCredentials => "check user and key credentials",
            Remediation::CheckAlgorithms => "check client/server algorithm configuration",
            Remediation::CheckHostKeyPin => "compare fingerprints and review the pin",
            Remediation::Retry => "retry",
            Remediation::RetryLater => "retry after it finishes",
            Remediation::CheckIdentityPins => "review pins or choose another board",
            Remediation::RebindAttach => "re-run `Select SSH Target`",
            Remediation::BuildWithCMakeTools => "build with CMake Tools (never implicitly)",
            Remediation::CheckArtifactToolchain => "check toolchain and core selection",
            Remediation::DeploySingleArtifact => {
                "deploy a single-artifact target (selection arrives in a later phase)"
            }
            Remediation::CheckPrivileges => "check account privilege mode and sudo whitelist",
            Remediation::ReclassifyWorkspace => {
                "re-classify the workspace as big-core or choose another board"
            }
            Remediation::RestorePreviousVersion => "restore the previous version",
            Remediation::InspectTrace => "inspect trace output",
            Remediation::InstallGdbserver => "install `gdbserver` (or copy a transient static one)",
            Remediation::InstallDebugAdapter => {
                "install the debug adapter (CodeLLDB in the VS Code frontend)"
            }
            Remediation::UpgradeFrontend => "upgrade the frontend or core to matching versions",
            Remediation::ShowLog => "show log",
            Remediation::None => "informational",
        }
    }
}

/// Static metadata for one catalog entry. `phase: None` means the code can
/// occur in any phase (`internal.unexpected` carries its real phase).
#[derive(Debug, Clone, Copy)]
pub struct ErrorDef {
    pub phase: Option<Phase>,
    pub retriable: bool,
    pub remediation: Remediation,
    pub summary: &'static str,
}

/// Every failure the core can report. The wire representation is the dotted
/// string from [`ErrorCode::code`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    ProtocolMismatch,
    ProfileUnresolved,
    ProfileUnsupportedProxy,
    ConfigInvalid,
    SshUnreachable,
    SshAuthFailed,
    SshHandshakeFailed,
    SshHostkeyMismatch,
    SshLost,
    IdentityDescriptorMismatch,
    IdentityInstanceChanged,
    ArtifactMissing,
    ArtifactArchMismatch,
    ArtifactAmbiguous,
    DeployBusy,
    DeployCancelled,
    DeployUploadFailed,
    DeployCommitFailed,
    PrivilegeDenied,
    RprocInstanceMissing,
    RprocStopFailed,
    RprocCrashed,
    RprocStateTimeout,
    DebugGdbserverMissing,
    DebugAdapterMissing,
    InternalUnexpected,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 26] = [
        ErrorCode::ProtocolMismatch,
        ErrorCode::ProfileUnresolved,
        ErrorCode::ProfileUnsupportedProxy,
        ErrorCode::ConfigInvalid,
        ErrorCode::SshUnreachable,
        ErrorCode::SshAuthFailed,
        ErrorCode::SshHandshakeFailed,
        ErrorCode::SshHostkeyMismatch,
        ErrorCode::SshLost,
        ErrorCode::IdentityDescriptorMismatch,
        ErrorCode::IdentityInstanceChanged,
        ErrorCode::ArtifactMissing,
        ErrorCode::ArtifactArchMismatch,
        ErrorCode::ArtifactAmbiguous,
        ErrorCode::DeployBusy,
        ErrorCode::DeployCancelled,
        ErrorCode::DeployUploadFailed,
        ErrorCode::DeployCommitFailed,
        ErrorCode::PrivilegeDenied,
        ErrorCode::RprocInstanceMissing,
        ErrorCode::RprocStopFailed,
        ErrorCode::RprocCrashed,
        ErrorCode::RprocStateTimeout,
        ErrorCode::DebugGdbserverMissing,
        ErrorCode::DebugAdapterMissing,
        ErrorCode::InternalUnexpected,
    ];

    /// Stable wire name, e.g. `ssh.lost`. Namespaced per area; strategy codes
    /// use their strategy namespace (`rproc.*` for `linux.remoteproc`).
    pub fn code(self) -> &'static str {
        match self {
            ErrorCode::ProtocolMismatch => "protocol.mismatch",
            ErrorCode::ProfileUnresolved => "profile.unresolved",
            ErrorCode::ProfileUnsupportedProxy => "profile.unsupported-proxy",
            ErrorCode::ConfigInvalid => "config.invalid",
            ErrorCode::SshUnreachable => "ssh.unreachable",
            ErrorCode::SshAuthFailed => "ssh.auth-failed",
            ErrorCode::SshHandshakeFailed => "ssh.handshake-failed",
            ErrorCode::SshHostkeyMismatch => "ssh.hostkey-mismatch",
            ErrorCode::SshLost => "ssh.lost",
            ErrorCode::IdentityDescriptorMismatch => "identity.descriptor-mismatch",
            ErrorCode::IdentityInstanceChanged => "identity.instance-changed",
            ErrorCode::ArtifactMissing => "artifact.missing",
            ErrorCode::ArtifactArchMismatch => "artifact.arch-mismatch",
            ErrorCode::ArtifactAmbiguous => "artifact.ambiguous",
            ErrorCode::DeployBusy => "deploy.busy",
            ErrorCode::DeployCancelled => "deploy.cancelled",
            ErrorCode::DeployUploadFailed => "deploy.upload-failed",
            ErrorCode::DeployCommitFailed => "deploy.commit-failed",
            ErrorCode::PrivilegeDenied => "privilege.denied",
            ErrorCode::RprocInstanceMissing => "rproc.instance-missing",
            ErrorCode::RprocStopFailed => "rproc.stop-failed",
            ErrorCode::RprocCrashed => "rproc.crashed",
            ErrorCode::RprocStateTimeout => "rproc.state-timeout",
            ErrorCode::DebugGdbserverMissing => "debug.gdbserver-missing",
            ErrorCode::DebugAdapterMissing => "debug.adapter-missing",
            ErrorCode::InternalUnexpected => "internal.unexpected",
        }
    }

    pub fn def(self) -> ErrorDef {
        use ErrorCode::*;
        use Phase::*;
        use Remediation as R;
        match self {
            ProtocolMismatch => ErrorDef {
                phase: Some(Config),
                retriable: false,
                remediation: R::UpgradeFrontend,
                summary: "The frontend and core speak incompatible protocol versions.",
            },
            ProfileUnresolved => ErrorDef {
                phase: Some(Profile),
                retriable: false,
                remediation: R::CheckProfileSettings,
                summary: "The target profile was not found or is incomplete.",
            },
            ProfileUnsupportedProxy => ErrorDef {
                phase: Some(Profile),
                retriable: false,
                remediation: R::FixProxySettings,
                summary: "The profile uses a proxy form the transport cannot express.",
            },
            ConfigInvalid => ErrorDef {
                phase: Some(Config),
                retriable: false,
                remediation: R::OpenSettings,
                summary: "A betelgeuz setting has an invalid value.",
            },
            SshUnreachable => ErrorDef {
                phase: Some(Connect),
                retriable: true,
                remediation: R::CheckNetworkAndSshService,
                summary: "The SSH endpoint could not be reached (timeout, refused, or unresolvable).",
            },
            SshAuthFailed => ErrorDef {
                phase: Some(Connect),
                retriable: false,
                remediation: R::CheckCredentials,
                summary: "SSH authentication failed for the configured user.",
            },
            SshHandshakeFailed => ErrorDef {
                phase: Some(Connect),
                retriable: false,
                remediation: R::CheckAlgorithms,
                summary: "The SSH handshake failed before authentication (key exchange or key format).",
            },
            SshHostkeyMismatch => ErrorDef {
                phase: Some(Identity),
                retriable: false,
                remediation: R::CheckHostKeyPin,
                summary: "The presented SSH host key does not match the pinned or recorded key.",
            },
            SshLost => ErrorDef {
                phase: Some(Connect),
                retriable: true,
                remediation: R::Retry,
                summary: "An established SSH connection dropped during an operation.",
            },
            IdentityDescriptorMismatch => ErrorDef {
                phase: Some(Identity),
                retriable: false,
                remediation: R::CheckIdentityPins,
                summary: "The hardware descriptor does not match the pinned board identity.",
            },
            IdentityInstanceChanged => ErrorDef {
                phase: Some(Identity),
                retriable: false,
                remediation: R::RebindAttach,
                summary: "The backend instance identity changed since the attach was created.",
            },
            ArtifactMissing => ErrorDef {
                phase: Some(Artifact),
                retriable: false,
                remediation: R::BuildWithCMakeTools,
                summary: "No existing artifact was found for the selected CMake target.",
            },
            ArtifactArchMismatch => ErrorDef {
                phase: Some(Artifact),
                retriable: false,
                remediation: R::CheckArtifactToolchain,
                summary: "Host-side artifact validation failed (format or architecture).",
            },
            ArtifactAmbiguous => ErrorDef {
                phase: Some(Artifact),
                retriable: false,
                remediation: R::DeploySingleArtifact,
                summary: "The target produces multiple artifacts; the single-artifact rule applies in the MVP.",
            },
            DeployBusy => ErrorDef {
                phase: Some(Deploy),
                retriable: true,
                remediation: R::RetryLater,
                summary: "Another mutating operation is running on this attach.",
            },
            DeployCancelled => ErrorDef {
                phase: Some(Deploy),
                retriable: false,
                remediation: R::None,
                summary: "The operation was cancelled before its commit point; the target is unchanged.",
            },
            DeployUploadFailed => ErrorDef {
                phase: Some(Deploy),
                retriable: true,
                remediation: R::Retry,
                summary: "Upload to the staging location failed; nothing was activated.",
            },
            DeployCommitFailed => ErrorDef {
                phase: Some(Deploy),
                retriable: false,
                remediation: R::RestorePreviousVersion,
                summary: "Activating the staged artifact failed; carries the target state at the abort point.",
            },
            PrivilegeDenied => ErrorDef {
                phase: Some(Deploy),
                retriable: false,
                remediation: R::CheckPrivileges,
                summary: "The target account lacks the privilege required by a templated command.",
            },
            RprocInstanceMissing => ErrorDef {
                phase: Some(Lifecycle),
                retriable: false,
                remediation: R::ReclassifyWorkspace,
                summary: "The board exposes no supported small-core control interface for the configured core.",
            },
            RprocStopFailed => ErrorDef {
                phase: Some(Lifecycle),
                retriable: true,
                remediation: R::Retry,
                summary: "Stopping the small core failed; the deployed firmware is untouched.",
            },
            RprocCrashed => ErrorDef {
                phase: Some(Lifecycle),
                retriable: false,
                remediation: R::RestorePreviousVersion,
                summary: "The small core entered the crashed state; carries the kernel log tail when readable.",
            },
            RprocStateTimeout => ErrorDef {
                phase: Some(Lifecycle),
                retriable: true,
                remediation: R::InspectTrace,
                summary: "Timed out waiting for the core state transition; carries the last observed state.",
            },
            DebugGdbserverMissing => ErrorDef {
                phase: Some(Debug),
                retriable: false,
                remediation: R::InstallGdbserver,
                summary: "gdbserver is not available on the target for the debug session.",
            },
            DebugAdapterMissing => ErrorDef {
                phase: Some(Debug),
                retriable: false,
                remediation: R::InstallDebugAdapter,
                summary: "The frontend DAP integration (CodeLLDB in the VS Code frontend) is missing.",
            },
            InternalUnexpected => ErrorDef {
                phase: None,
                retriable: false,
                remediation: R::ShowLog,
                summary: "An unexpected failure occurred; carries the failed phase and the underlying cause.",
            },
        }
    }

    pub fn from_code(code: &str) -> Option<ErrorCode> {
        Self::ALL.iter().copied().find(|c| c.code() == code)
    }
}

/// A structured failure. Frontends render from `code`; the rest is context for
/// the log and for remediation actions. `cause` is stringified because errors
/// cross the frontend boundary as text.
#[derive(Debug)]
pub struct BetelgeuzError {
    pub code: ErrorCode,
    pub phase: Phase,
    pub retriable: bool,
    pub remediation: Remediation,
    pub target_state: Option<String>,
    pub detail: Option<String>,
    pub cause: Option<String>,
}

impl BetelgeuzError {
    pub fn new(code: ErrorCode) -> Self {
        let def = code.def();
        BetelgeuzError {
            code,
            phase: def.phase.unwrap_or(Phase::Inspect),
            retriable: def.retriable,
            remediation: def.remediation,
            target_state: None,
            detail: None,
            cause: None,
        }
    }

    /// Collapses any unexpected failure into `internal.unexpected` while
    /// preserving the phase in which it happened.
    pub fn wrap_unexpected(phase: Phase, cause: impl fmt::Display) -> Self {
        BetelgeuzError::new(ErrorCode::InternalUnexpected)
            .with_phase(phase)
            .with_cause(cause)
    }

    pub fn with_phase(mut self, phase: Phase) -> Self {
        self.phase = phase;
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn with_target_state(mut self, state: impl Into<String>) -> Self {
        self.target_state = Some(state.into());
        self
    }

    pub fn with_cause(mut self, cause: impl fmt::Display) -> Self {
        self.cause = Some(cause.to_string());
        self
    }
}

impl fmt::Display for BetelgeuzError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "betelgeuz.{}: {}", self.code.code(), self.code.def().summary)?;
        if let Some(detail) = &self.detail {
            write!(f, " [{detail}]")?;
        }
        Ok(())
    }
}

impl std::error::Error for BetelgeuzError {}

/// JSON-RPC application error code carrying a catalog error in `data`.
pub const APPLICATION_ERROR_CODE: i64 = -32000;

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<RpcErrorData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorData {
    pub code: String,
    pub phase: &'static str,
    pub retriable: bool,
    pub remediation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl RpcError {
    /// An error from the catalog: structured data, uniform rendering.
    pub fn application(err: &BetelgeuzError) -> Self {
        RpcError {
            code: APPLICATION_ERROR_CODE,
            message: err.to_string(),
            data: Some(RpcErrorData {
                code: err.code.code().to_string(),
                phase: err.phase.as_str(),
                retriable: err.retriable,
                remediation: err.remediation.as_str(),
                target_state: err.target_state.clone(),
                detail: err.detail.clone(),
            }),
        }
    }

    /// A protocol-level error (parse, invalid request, unknown method).
    pub fn protocol(code: i64, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_namespaced_and_resolvable() {
        for code in ErrorCode::ALL {
            let name = code.code();
            assert!(name.contains('.'), "{name} must be namespaced");
            assert!(name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '.' || c == '-'));
            assert_eq!(ErrorCode::from_code(name), Some(code));
        }
    }

    #[test]
    fn every_code_has_a_remediation_and_summary() {
        for code in ErrorCode::ALL {
            let def = code.def();
            assert!(!def.summary.is_empty());
            assert!(!def.remediation.as_str().is_empty());
        }
    }

    #[test]
    fn application_error_carries_catalog_data() {
        let err = BetelgeuzError::new(ErrorCode::SshLost).with_detail("eof");
        let rpc = RpcError::application(&err);
        let data = rpc.data.expect("application errors carry data");
        assert_eq!(data.code, "ssh.lost");
        assert_eq!(data.phase, "connect");
        assert!(data.retriable);
        assert_eq!(data.detail.as_deref(), Some("eof"));
    }

    #[test]
    fn wrap_unexpected_keeps_the_phase() {
        let err = BetelgeuzError::wrap_unexpected(Phase::Deploy, "boom");
        assert_eq!(err.code, ErrorCode::InternalUnexpected);
        assert_eq!(err.phase, Phase::Deploy);
        assert_eq!(err.cause.as_deref(), Some("boom"));
    }
}
