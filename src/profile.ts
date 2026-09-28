/**
 * Profile resolution: overlays workspace overrides onto the selected
 * user-level profile and validates the resulting connection settings.
 *
 * This module reads connection settings only. It never loads credential
 * material or trusts descriptor data; the returned credential reference is
 * resolved by the credential service, and an unpinned host requires explicit
 * enrollment before target data is read.
 *
 * Empty strings are treated as unset so an editor's empty settings do not
 * erase values inherited from a named profile.
 */
import { BetelgeuzError } from "./errors";
import type { ProfileCatalog, ProxyHopProfile, TargetOverrides } from "./protocol";

export interface ResolvedTargetProfile {
  profileName?: string;
  host: string;
  port: number;
  username: string;
  credentialRef: string;
  hostKey?: string;
  deviceId?: string;
  boardId?: string;
  socId?: string;
  keepaliveSeconds: number;
  proxyChain: Array<ProxyHopProfile>;
}

const DEFAULT_SSH_PORT = 22;
const DEFAULT_KEEPALIVE_SECONDS = 30;

/** Whitespace or control characters (the Rust `is_whitespace || is_control`). */
const UNPRINTABLE = /[\s\u0000-\u001f\u007f-\u009f]/;

/** Resolves profile settings without connecting or consulting target data. */
export function resolveProfile(
  catalog: ProfileCatalog,
  overrides: TargetOverrides
): ResolvedTargetProfile {
  const profileName = nonEmpty(overrides.profile);
  const profile = profileName === undefined ? undefined : catalog[profileName];
  if (profileName !== undefined && profile === undefined) {
    throw new BetelgeuzError("profile.unresolved", {
      detail: `profile \`${profileName}\` was not found`,
    });
  }

  const host = select(overrides.host, profile?.host) ?? incompleteProfile();
  const username = select(overrides.username, profile?.username) ?? incompleteProfile();
  const credentialRef =
    select(overrides.credentialRef, profile?.credentialRef) ?? incompleteProfile();

  const port = overrides.port ?? profile?.port ?? DEFAULT_SSH_PORT;
  validateU16(port, "SSH port must be between 1 and 65535");
  if (UNPRINTABLE.test(host)) {
    throw new BetelgeuzError("config.invalid", {
      detail: "SSH host must not contain whitespace",
    });
  }

  const keepaliveSeconds =
    overrides.keepaliveSeconds ?? profile?.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS;
  validateU16(keepaliveSeconds, "SSH keepalive interval must be between 1 and 65535");

  const proxyChain = (overrides.proxyChain ?? profile?.proxyChain ?? []).map((hop) => ({
    ...hop,
    port: hop.port ?? DEFAULT_SSH_PORT,
  }));
  for (const hop of proxyChain) {
    const valid =
      hop.host.trim() !== "" &&
      !UNPRINTABLE.test(hop.host) &&
      isU16(hop.port) &&
      hop.username.trim() !== "" &&
      hop.credentialRef.trim() !== "" &&
      hop.hostKey.trim() !== "";
    if (!valid) {
      throw new BetelgeuzError("config.invalid", {
        detail:
          "each SSH proxy hop requires a valid endpoint, credential reference, and host-key pin",
      });
    }
  }

  return {
    profileName,
    host,
    port,
    username,
    credentialRef,
    hostKey: select(overrides.hostKey, profile?.hostKey),
    deviceId: select(overrides.deviceId, profile?.deviceId),
    boardId: select(overrides.boardId, profile?.boardId),
    socId: select(overrides.socId, profile?.socId),
    keepaliveSeconds,
    proxyChain,
  };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value !== undefined && value !== null && value.trim() !== ""
    ? value
    : undefined;
}

function isU16(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function validateU16(value: number, detail: string): void {
  if (!isU16(value)) {
    throw new BetelgeuzError("config.invalid", { detail });
  }
}

function select(
  value: string | null | undefined,
  inherited: string | null | undefined
): string | undefined {
  return nonEmpty(value) ?? nonEmpty(inherited);
}

function incompleteProfile(): never {
  throw new BetelgeuzError("profile.unresolved", {
    detail: "host, username, and credentialRef must resolve to non-empty values",
  });
}
