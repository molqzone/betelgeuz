//! SSH transport: one session manager behind a core-internal trait.
//!
//! Betelgeuz ships exactly one production transport (russh); the trait exists
//! so tests can substitute a fake, not as a user-selectable plugin point. All
//! strategies share the session owned here — a strategy never opens its own
//! connection. There is no dependency on a local `ssh` executable, external
//! SSH configuration, agent sockets, or known-host databases.

// TODO(Phase 0): `SshTransport` trait — exec / SFTP / port-forward channels
// over one session, connection state and reconnect events, host-key
// verification hooks, and mapping transport failures to common core error
// definitions. Then the russh implementation and the test fake.

/// Marker for the transport layer boundary; the trait lands in Phase 0.
pub struct TransportPlaceholder;
