//! The hardware descriptor read from the target after host-key verification.
//!
//! Preferred source: a board-provided `/etc/betelgeuz/device.json`. On stock
//! vendor and community images that file is normally absent; the common case is
//! device-tree derived metadata combined with a pinned host key as the
//! authoritative identity. Missing fields are `None` and rendered as unknown.
//! The descriptor is untrusted metadata until the host key has been verified.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareDescriptor {
    /// Stable board identity; required for identity pinning when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soc_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Version of the descriptor format itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_partial_descriptor() {
        let json = r#"{"deviceId":"abc-123","socId":"rk3506","model":"my-board"}"#;
        let d: HardwareDescriptor = serde_json::from_str(json).unwrap();
        assert_eq!(d.device_id.as_deref(), Some("abc-123"));
        assert_eq!(d.board_revision, None);
    }

    #[test]
    fn missing_fields_are_unknown_not_errors() {
        let d: HardwareDescriptor = serde_json::from_str("{}").unwrap();
        assert_eq!(d, HardwareDescriptor::default());
    }
}
