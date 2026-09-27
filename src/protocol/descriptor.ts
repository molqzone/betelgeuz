/**
 * The hardware descriptor read from the target after host-key verification.
 *
 * Preferred source: a board-provided `/etc/betelgeuz/device.json`. On stock
 * vendor and community images that file is normally absent; the common case is
 * device-tree derived metadata combined with a pinned host key as the
 * authoritative identity. Missing fields are `undefined` and rendered as
 * unknown. The descriptor is untrusted metadata until the host key has been
 * verified.
 */
export type HardwareDescriptor = {
  boardId?: string | null;
  boardRevision?: string | null;
  deviceId?: string | null;
  model?: string | null;
  protocolVersion?: number | null;
  socId?: string | null;
};
