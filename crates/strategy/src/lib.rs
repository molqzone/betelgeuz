//! Deploy strategies are peers behind one contract, not hardcoded branches.
//!
//! Each strategy registers a contract implementation plus declarative metadata:
//! its ID and configuration schema, the error-code namespace, its privilege
//! class, and a detection predicate evaluated over the identity descriptor and
//! probe results. Binding resolves strategy = role × detection: the workspace
//! states its role, the board probe determines which strategies can serve it,
//! the match is selected automatically, and explicit configuration overrides.
//!
//! The shared pipeline — validate, stage, commit, activate, verify — lives
//! here and carries the common machinery (staging and commit-point semantics,
//! progress, cancellation, busy locking, error plumbing, retention of the
//! previously activated artifact). Strategies fill only the slots that differ.

use errors::{ErrorCatalogEntry, ErrorDef, Phase};

/// Error metadata owned by the strategy that defines the corresponding codes.
pub const ERROR_CATALOG: &[ErrorCatalogEntry] = &[
    ErrorCatalogEntry {
        code: "rproc.instance-missing",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: false,
            remediation: "selectSupportedStrategy",
            summary: "The board exposes no supported small-core control interface for the configured core.",
        },
    },
    ErrorCatalogEntry {
        code: "rproc.stop-failed",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: true,
            remediation: "retry",
            summary: "Stopping the small core failed; the deployed firmware is untouched.",
        },
    },
    ErrorCatalogEntry {
        code: "rproc.crashed",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: false,
            remediation: "restorePreviousVersion",
            summary: "The small core entered the crashed state; carries the kernel log tail when readable.",
        },
    },
    ErrorCatalogEntry {
        code: "rproc.state-timeout",
        definition: ErrorDef {
            phase: Some(Phase::Lifecycle),
            retriable: true,
            remediation: "inspectTrace",
            summary: "Timed out waiting for the core state transition; carries the last observed state.",
        },
    },
];

// TODO(Phase 0): the `Strategy` trait (target paths and format checks,
// activation, lifecycle verbs, inspection and log source, privilege class),
// `StrategyMetadata` (id, config schema, code namespace, detection predicate),
// and the registry. The `linux.ssh-app` and `linux.remoteproc` strategies land
// as registry entries in Phase 1 and Phase 3 respectively.

/// Marker for the strategy boundary; the trait lands in Phase 0.
pub struct StrategyPlaceholder;
