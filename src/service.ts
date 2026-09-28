/**
 * Core service: the orchestration layer between the surface and the transport.
 *
 * Profile resolution and one-use credential lookup live here. The surface
 * passes typed values to this service and never constructs SSH options,
 * commands, or transport calls itself.
 */
import { BetelgeuzError } from "./errors";
import { resolveProfile, type ResolvedTargetProfile } from "./profile";
import { Secret } from "./secret";
import {
  HostKeyFingerprint,
  type Authentication,
  type SshConnectOptions,
  type SshEndpoint,
  type SshProxyHop,
  type SshTransport,
} from "./transport";
import type {
  AttachRef,
  AttachRequest,
  AttachResult,
  CredentialSecrets,
  DisconnectResult,
  InspectHostKeyParams,
  InspectHostKeyResult,
  ProxyHopProfile,
  ResolveProfileParams,
  ResolveProfileResult,
  ResolvedProfile,
} from "./protocol";

export class CoreService<T extends SshTransport> {
  private attachedId?: string;
  private nextAttachId = 1;

  constructor(private readonly transport: T) {}

  resolveProfile(params: ResolveProfileParams): ResolveProfileResult {
    const resolved = resolveProfile(params.catalog, params.target);
    return { profile: publicProfile(resolved) };
  }

  /** Probe before enrollment: reads the server key without accepting the
   * session so the user can approve a pin. */
  async inspectHostKey(params: InspectHostKeyParams): Promise<InspectHostKeyResult> {
    const resolved = resolveProfile(params.catalog, params.target);
    const fingerprint = await this.transport.inspectHostKey(endpointFor(resolved));
    return { hostKeyFingerprint: fingerprint.asString() };
  }

  async attach(request: AttachRequest): Promise<AttachResult> {
    if (this.attachedId !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "another attach is already active",
      });
    }
    const resolved = resolveProfile(request.catalog, request.target);
    const hostKey = resolved.hostKey;
    if (hostKey === undefined) {
      throw new BetelgeuzError("ssh.hostkey-mismatch", {
        detail: "host-key enrollment required before attach",
      });
    }
    const pin = HostKeyFingerprint.parse(hostKey);
    const endpoint = endpointFor(resolved);

    // Probe first so a mismatched or unpinned key is distinguished from an
    // authentication or network failure before a session is opened.
    const observed = await this.transport.inspectHostKey(endpoint);
    if (observed.asString() !== pin.asString()) {
      throw new BetelgeuzError("ssh.hostkey-mismatch", {
        detail: `expected pin ${hostKey}, observed ${observed.asString()}`,
      });
    }

    // One-use credential material: entries move out of a shallow copy, so a
    // reference used twice errors instead of silently duplicating secrets.
    const secrets: CredentialSecrets = { ...request.credentialSecrets };
    const options: SshConnectOptions = {
      endpoint,
      authentication: passwordAuth(secrets, resolved.credentialRef),
      hostKeyPin: pin,
      proxyChain: resolved.proxyChain.map((hop) => proxyOptions(hop, secrets)),
      keepaliveSeconds: resolved.keepaliveSeconds,
    };
    await this.transport.connect(options);

    const attachId = `attach-${this.nextAttachId}`;
    this.nextAttachId += 1;
    this.attachedId = attachId;
    return {
      attachId,
      // The descriptor is intentionally empty until a verified-session
      // inspection lands (the identity step).
      identity: {
        descriptor: {},
        host: resolved.host,
        hostKeyFingerprint: pin.asString(),
        port: resolved.port,
      },
      operations: [],
      profile: publicProfile(resolved),
      state: "attached",
      strategyId: request.strategyId,
    };
  }

  async disconnect(ref: AttachRef): Promise<DisconnectResult> {
    if (this.attachedId === undefined) {
      return { state: "disconnected" };
    }
    if (ref.attachId !== this.attachedId) {
      // A stale reference names an attach that is no longer the active one.
      throw new BetelgeuzError("identity.instance-changed", {
        detail: "the named attach is not the active attach",
      });
    }
    this.attachedId = undefined;
    await this.transport.close();
    return { state: "disconnected" };
  }
}

function endpointFor(resolved: ResolvedTargetProfile): SshEndpoint {
  return { host: resolved.host, port: resolved.port, username: resolved.username };
}

function publicProfile(resolved: ResolvedTargetProfile): ResolvedProfile {
  return {
    boardId: resolved.boardId,
    deviceId: resolved.deviceId,
    host: resolved.host,
    hostKeyPinned: resolved.hostKey !== undefined,
    keepaliveSeconds: resolved.keepaliveSeconds,
    port: resolved.port,
    profileName: resolved.profileName,
    proxyHops: resolved.proxyChain.length,
    socId: resolved.socId,
    username: resolved.username,
  };
}

/** One-use credential lookup: the entry is consumed on use. */
function passwordAuth(secrets: CredentialSecrets, credentialRef: string): Authentication {
  const material = secrets[credentialRef];
  if (material === undefined) {
    throw new BetelgeuzError("ssh.auth-failed", {
      detail: `credential material for \`${credentialRef}\` was not supplied or was already used`,
    });
  }
  delete secrets[credentialRef];
  const password = material.password;
  if (password === undefined) {
    throw new BetelgeuzError("ssh.auth-failed", {
      detail: "only password credentials are available for this attach",
    });
  }
  return { kind: "password", password: new Secret(password) };
}

function proxyOptions(hop: ProxyHopProfile, secrets: CredentialSecrets): SshProxyHop {
  return {
    endpoint: {
      host: hop.host,
      port: hop.port ?? 22,
      username: hop.username,
    },
    authentication: passwordAuth(secrets, hop.credentialRef),
    hostKeyPin: HostKeyFingerprint.parse(hop.hostKey),
  };
}
