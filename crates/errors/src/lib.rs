//! Core-owned error semantics. Strategies may contribute their own
//! [`ErrorDef`] values without extending this crate's common error enum.

use std::fmt;

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

/// Static metadata for one catalog entry. `phase: None` means the code can
/// occur in any phase (`internal.unexpected` carries its real phase).
#[derive(Debug, Clone, Copy)]
pub struct ErrorDef {
    pub phase: Option<Phase>,
    pub retriable: bool,
    /// Stable action identifier; frontends map it to localized UI.
    pub remediation: &'static str,
    pub summary: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct ErrorCatalogEntry {
    pub code: &'static str,
    pub definition: ErrorDef,
}

/// Common core failures. Strategy-specific codes are defined by their strategy.
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
    StrategyUnsupportedTarget,
    DeployBusy,
    DeployCancelled,
    DeployUploadFailed,
    DeployCommitFailed,
    PrivilegeDenied,
    DebugGdbserverMissing,
    InternalUnexpected,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 22] = [
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
        ErrorCode::StrategyUnsupportedTarget,
        ErrorCode::DeployBusy,
        ErrorCode::DeployCancelled,
        ErrorCode::DeployUploadFailed,
        ErrorCode::DeployCommitFailed,
        ErrorCode::PrivilegeDenied,
        ErrorCode::DebugGdbserverMissing,
        ErrorCode::InternalUnexpected,
    ];

    /// Stable wire name, e.g. `ssh.lost`.
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
            ErrorCode::StrategyUnsupportedTarget => "strategy.unsupported-target",
            ErrorCode::DeployBusy => "deploy.busy",
            ErrorCode::DeployCancelled => "deploy.cancelled",
            ErrorCode::DeployUploadFailed => "deploy.upload-failed",
            ErrorCode::DeployCommitFailed => "deploy.commit-failed",
            ErrorCode::PrivilegeDenied => "privilege.denied",
            ErrorCode::DebugGdbserverMissing => "debug.gdbserver-missing",
            ErrorCode::InternalUnexpected => "internal.unexpected",
        }
    }

    pub fn def(self) -> ErrorDef {
        use ErrorCode::*;
        use Phase::*;
        match self {
            ProtocolMismatch => ErrorDef {
                phase: Some(Config),
                retriable: false,
                remediation: "upgradeFrontend",
                summary: "The frontend and core speak incompatible protocol versions.",
            },
            ProfileUnresolved => ErrorDef {
                phase: Some(Profile),
                retriable: false,
                remediation: "checkProfileSettings",
                summary: "The target profile was not found or is incomplete.",
            },
            ProfileUnsupportedProxy => ErrorDef {
                phase: Some(Profile),
                retriable: false,
                remediation: "fixProxySettings",
                summary: "The profile uses a proxy form the transport cannot express.",
            },
            ConfigInvalid => ErrorDef {
                phase: Some(Config),
                retriable: false,
                remediation: "openSettings",
                summary: "A betelgeuz setting has an invalid value.",
            },
            SshUnreachable => ErrorDef {
                phase: Some(Connect),
                retriable: true,
                remediation: "checkNetworkAndSshService",
                summary: "The SSH endpoint could not be reached (timeout, refused, or unresolvable).",
            },
            SshAuthFailed => ErrorDef {
                phase: Some(Connect),
                retriable: false,
                remediation: "checkCredentials",
                summary: "SSH authentication failed for the configured user.",
            },
            SshHandshakeFailed => ErrorDef {
                phase: Some(Connect),
                retriable: false,
                remediation: "checkAlgorithms",
                summary: "The SSH handshake failed before authentication (key exchange or key format).",
            },
            SshHostkeyMismatch => ErrorDef {
                phase: Some(Identity),
                retriable: false,
                remediation: "checkHostKeyPin",
                summary: "The presented SSH host key does not match the pinned or recorded key.",
            },
            SshLost => ErrorDef {
                phase: Some(Connect),
                retriable: true,
                remediation: "retry",
                summary: "An established SSH connection dropped during an operation.",
            },
            IdentityDescriptorMismatch => ErrorDef {
                phase: Some(Identity),
                retriable: false,
                remediation: "checkIdentityPins",
                summary: "The hardware descriptor does not match the pinned board identity.",
            },
            IdentityInstanceChanged => ErrorDef {
                phase: Some(Identity),
                retriable: false,
                remediation: "rebindAttach",
                summary: "The backend instance identity changed since the attach was created.",
            },
            ArtifactMissing => ErrorDef {
                phase: Some(Artifact),
                retriable: false,
                remediation: "buildWithCMakeTools",
                summary: "No existing artifact was found for the selected CMake target.",
            },
            ArtifactArchMismatch => ErrorDef {
                phase: Some(Artifact),
                retriable: false,
                remediation: "checkArtifactToolchain",
                summary: "Host-side artifact validation failed (format or architecture).",
            },
            ArtifactAmbiguous => ErrorDef {
                phase: Some(Artifact),
                retriable: false,
                remediation: "deploySingleArtifact",
                summary: "The target produces multiple artifacts; the single-artifact rule applies in the MVP.",
            },
            StrategyUnsupportedTarget => ErrorDef {
                phase: Some(Inspect),
                retriable: false,
                remediation: "selectSupportedStrategy",
                summary: "The selected strategy's required target interface is unavailable.",
            },
            DeployBusy => ErrorDef {
                phase: Some(Deploy),
                retriable: true,
                remediation: "retryLater",
                summary: "Another mutating operation is running on this attach.",
            },
            DeployCancelled => ErrorDef {
                phase: Some(Deploy),
                retriable: false,
                remediation: "none",
                summary: "The operation was cancelled before its commit point; the target is unchanged.",
            },
            DeployUploadFailed => ErrorDef {
                phase: Some(Deploy),
                retriable: true,
                remediation: "retry",
                summary: "Upload to the staging location failed; nothing was activated.",
            },
            DeployCommitFailed => ErrorDef {
                phase: Some(Deploy),
                retriable: false,
                remediation: "restorePreviousVersion",
                summary: "Activating the staged artifact failed; carries the target state at the abort point.",
            },
            PrivilegeDenied => ErrorDef {
                phase: Some(Deploy),
                retriable: false,
                remediation: "checkPrivileges",
                summary: "The target account lacks the privilege required by a templated command.",
            },
            DebugGdbserverMissing => ErrorDef {
                phase: Some(Debug),
                retriable: false,
                remediation: "installGdbserver",
                summary: "gdbserver is not available on the target for the debug session.",
            },
            InternalUnexpected => ErrorDef {
                phase: None,
                retriable: false,
                remediation: "showLog",
                summary: "An unexpected failure occurred; carries the failed phase and the underlying cause.",
            },
        }
    }
}

/// A structured failure. Frontends render from `code`; the rest is context for
/// the log and for remediation actions. `cause` is stringified because errors
/// cross the frontend boundary as text.
#[derive(Debug)]
pub struct BetelgeuzError {
    pub code: &'static str,
    pub summary: &'static str,
    pub phase: Phase,
    pub retriable: bool,
    pub remediation: &'static str,
    pub target_state: Option<String>,
    pub detail: Option<String>,
    pub cause: Option<String>,
}

impl BetelgeuzError {
    pub fn new(code: ErrorCode) -> Self {
        let def = code.def();
        Self::from_definition(code.code(), def)
    }

    pub fn from_definition(code: &'static str, def: ErrorDef) -> Self {
        BetelgeuzError {
            code,
            summary: def.summary,
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
        write!(f, "betelgeuz.{}: {}", self.code, self.summary)?;
        if let Some(detail) = &self.detail {
            write!(f, " [{detail}]")?;
        }
        Ok(())
    }
}

impl std::error::Error for BetelgeuzError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_error_uses_catalog_metadata() {
        let err = BetelgeuzError::new(ErrorCode::SshLost).with_detail("eof");
        assert_eq!(err.code, "ssh.lost");
        assert_eq!(err.phase, Phase::Connect);
        assert!(err.retriable);
        assert_eq!(err.remediation, "retry");
        assert_eq!(err.detail.as_deref(), Some("eof"));
    }

    #[test]
    fn unexpected_error_preserves_phase() {
        let err = BetelgeuzError::wrap_unexpected(Phase::Deploy, "boom");
        assert_eq!(err.code, "internal.unexpected");
        assert_eq!(err.phase, Phase::Deploy);
        assert_eq!(err.cause.as_deref(), Some("boom"));
    }
}
