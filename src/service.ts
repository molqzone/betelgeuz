/**
 * Core service: the orchestration layer between the surface and the transport.
 *
 * Profile resolution and one-use credential lookup live here. The surface
 * passes typed values to this service and never constructs SSH options,
 * commands, or transport calls itself.
 */
import { BetelgeuzError } from "./errors";
import { throwIfAborted } from "./cancellation";
import { resolveProfile, type ResolvedTargetProfile } from "./profile";
import { assertDescriptorMatches, readHardwareDescriptor } from "./protocol/descriptor";
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
  DeployRequest,
  DeployResult,
  DisconnectResult,
  InspectHostKeyParams,
  InspectHostKeyResult,
  LogsParams,
  LogsResult,
  ProxyHopProfile,
  ReconnectRequest,
  RestartRequest,
  ResolveProfileParams,
  ResolveProfileResult,
  ResolvedProfile,
  StartRequest,
  StatusRequest,
  StopRequest,
  VerifiedTargetIdentity,
} from "./protocol";
import {
  SshApplicationStrategy,
  type ApplicationRun,
  type ApplicationStatus,
  type OutputListener,
  type RunOutcome,
} from "./strategies/ssh-app";

/** The identity-relevant fields an attach binds to: the endpoint plus the
 *  profile's pins. Anything else (keepalive, credential reference) may change
 *  without touching the binding. */
type IdentityBinding = {
  boardId?: string;
  deviceId?: string;
  host: string;
  hostKey?: string;
  port: number;
  socId?: string;
  username: string;
};

export class CoreService<T extends SshTransport> {
  private attachedId?: string;
  private nextAttachId = 1;
  private nextOperationId = 1;
  private activeStrategyId?: string;
  private boundTarget?: IdentityBinding;
  private readonly application: SshApplicationStrategy;

  constructor(private readonly transport: T) {
    this.application = new SshApplicationStrategy(transport);
  }

  resolveProfile(params: ResolveProfileParams): ResolveProfileResult {
    const resolved = resolveProfile(params.catalog, params.target);
    return { profile: publicProfile(resolved) };
  }

  /** Probe before enrollment: reads the server key without accepting the
   * session so the user can approve a pin. */
  async inspectHostKey(
    params: InspectHostKeyParams,
    signal?: AbortSignal
  ): Promise<InspectHostKeyResult> {
    throwIfAborted(signal, "identity");
    const resolved = resolveProfile(params.catalog, params.target);
    const fingerprint = await this.transport.inspectHostKey(
      endpointFor(resolved),
      signal
    );
    throwIfAborted(signal, "identity");
    return { hostKeyFingerprint: fingerprint.asString() };
  }

  async attach(request: AttachRequest, signal?: AbortSignal): Promise<AttachResult> {
    throwIfAborted(signal, "connect");
    if (this.attachedId !== undefined) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "another attach is already active",
      });
    }
    const resolved = resolveProfile(request.catalog, request.target);
    const identity = await this.handshake(
      resolved,
      request.credentialSecrets,
      signal
    );
    const attachId = `attach-${this.nextAttachId}`;
    this.nextAttachId += 1;
    this.attachedId = attachId;
    this.activeStrategyId = request.strategyId;
    this.boundTarget = identityBindingOf(resolved);
    return {
      attachId,
      identity,
      operations: [],
      profile: publicProfile(resolved),
      state: "attached",
      strategyId: request.strategyId,
    };
  }

  /**
   * Re-establishes the session of an existing attach after a drop, keeping the
   * attach's identity, strategy, and per-attach history. The identity handshake
   * runs in full before anything is reported — the plan's rule is that a
   * reconnect re-validates identity before the UI reports target state.
   *
   * A pin mismatch or an identity-relevant settings change invalidates the
   * attach (plan §3: the old binding is discarded); a plain connectivity
   * failure keeps it, so the bounded retry loop can try again.
   */
  async reconnect(
    request: ReconnectRequest,
    signal?: AbortSignal
  ): Promise<AttachResult> {
    throwIfAborted(signal, "connect");
    const strategyId = this.activeStrategyId;
    if (this.attachedId === undefined || this.attachedId !== request.attachId) {
      throw new BetelgeuzError("identity.instance-changed", {
        detail: "the named attach is not the active attach",
      });
    }
    const resolved = resolveProfile(request.catalog, request.target);
    if (!sameBinding(this.boundTarget, identityBindingOf(resolved))) {
      await this.abandonAttach();
      throw new BetelgeuzError("identity.instance-changed", {
        detail: "the configured target identity changed since this attach was bound",
      });
    }
    let identity;
    try {
      identity = await this.handshake(resolved, request.credentialSecrets, signal);
    } catch (error) {
      if (isIdentityFailure(error)) {
        // A revalidation failure is a statement about the binding, not the
        // network: the board in front of us is not the one this attach
        // verified, so the binding is discarded rather than retried.
        await this.abandonAttach();
      }
      throw error;
    }
    return {
      attachId: request.attachId,
      identity,
      operations: [],
      profile: publicProfile(resolved),
      state: "attached",
      strategyId: strategyId ?? "unknown",
    };
  }

  /** The full identity handshake: pin check before any target data is read,
   *  then descriptor verification against the profile's pins. Shared by
   *  `attach` and `reconnect` so revalidation can never drift from binding. */
  private async handshake(
    resolved: ResolvedTargetProfile,
    credentialSecrets: CredentialSecrets | null | undefined,
    signal?: AbortSignal
  ): Promise<VerifiedTargetIdentity> {
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
    const observed = await this.transport.inspectHostKey(endpoint, signal);
    throwIfAborted(signal, "identity");
    if (observed.asString() !== pin.asString()) {
      throw new BetelgeuzError("ssh.hostkey-mismatch", {
        detail: `expected pin ${hostKey}, observed ${observed.asString()}`,
      });
    }

    // One-use credential material: entries move out of a shallow copy, so a
    // reference used twice errors instead of silently duplicating secrets.
    const secrets: CredentialSecrets = { ...credentialSecrets };
    const authentications: Array<Authentication> = [];
    let connected = false;
    try {
      const authentication = authenticationFor(secrets, resolved.credentialRef);
      authentications.push(authentication);
      const proxyChain = resolved.proxyChain.map((hop) => {
        const hostKeyPin = HostKeyFingerprint.parse(hop.hostKey);
        const hopAuthentication = authenticationFor(secrets, hop.credentialRef);
        authentications.push(hopAuthentication);
        return proxyOptions(hop, hopAuthentication, hostKeyPin);
      });
      const options: SshConnectOptions = {
        endpoint,
        authentication,
        hostKeyPin: pin,
        proxyChain,
        keepaliveSeconds: resolved.keepaliveSeconds,
      };
      await this.transport.connect(options, signal);
      connected = true;
      const descriptor = await readHardwareDescriptor(this.transport, signal);
      throwIfAborted(signal, "identity");
      assertDescriptorMatches(descriptor, resolved);

      return {
        descriptor,
        host: resolved.host,
        hostKeyFingerprint: pin.asString(),
        port: resolved.port,
      };
    } catch (error) {
      if (connected) {
        await this.transport.close();
      }
      throw error;
    } finally {
      for (const authentication of authentications) {
        wipeAuthentication(authentication);
      }
    }
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
    await this.application.stop(0).catch((error: unknown) => {
      if (error instanceof BetelgeuzError && error.code === "deploy.busy") {
        throw error;
      }
      return undefined;
    });
    this.application.reset();
    this.attachedId = undefined;
    this.activeStrategyId = undefined;
    this.boundTarget = undefined;
    await this.transport.close();
    return { state: "disconnected" };
  }

  /**
   * Drops the active attach after its session has already been lost. The busy
   * guards in `disconnect` keep a user from tearing down a working session
   * mid-operation, but a dropped channel can never finish one, so waiting for
   * it would leave the core permanently attached and every later `attach`
   * rejected as busy. Per-attach strategy state is cleared unconditionally for
   * the same reason.
   */
  async abandonAttach(): Promise<DisconnectResult> {
    this.attachedId = undefined;
    this.activeStrategyId = undefined;
    this.boundTarget = undefined;
    this.application.resetForcibly();
    await this.transport.close();
    return { state: "disconnected" };
  }

  async deploy(
    request: DeployRequest,
    signal?: AbortSignal
  ): Promise<DeployResult> {
    this.requireApplicationAttach(request.attachId);
    const deployed = await this.application.deploy(
      request.artifact,
      request.configuration,
      signal
    );
    return {
      operationId: `operation-${this.nextOperationId++}`,
      remotePath: deployed.remotePath,
      ...(deployed.previousSize === undefined
        ? {}
        : { previousSize: deployed.previousSize }),
    };
  }

  async start(
    request: StartRequest,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<ApplicationRun> {
    this.requireApplicationAttach(request.attachId);
    return await this.application.start(request.configuration, onOutput, signal);
  }

  async stop(request: StopRequest): Promise<RunOutcome | undefined> {
    this.requireApplicationAttach(request.attachId);
    return await this.application.stop(request.graceMs);
  }

  async restart(
    request: RestartRequest,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<ApplicationRun> {
    this.requireApplicationAttach(request.attachId);
    return await this.application.restart(request.configuration, onOutput, signal);
  }

  status(request: StatusRequest): ApplicationStatus {
    this.requireApplicationAttach(request.attachId);
    return this.application.status();
  }

  logs(request: LogsParams): LogsResult {
    this.requireApplicationAttach(request.attachId);
    return this.application.logs(request.cursor, request.maxBytes);
  }

  private requireApplicationAttach(attachId: string): void {
    if (this.attachedId === undefined || attachId !== this.attachedId) {
      throw new BetelgeuzError("identity.instance-changed", {
        detail: "the named attach is not the active attach",
      });
    }
    if (this.activeStrategyId !== "linux.ssh-app") {
      throw new BetelgeuzError("strategy.unsupported-target", {
        detail: `strategy ${this.activeStrategyId ?? "unknown"} has no Phase 1 operation implementation`,
      });
    }
  }
}

function endpointFor(resolved: ResolvedTargetProfile): SshEndpoint {
  return { host: resolved.host, port: resolved.port, username: resolved.username };
}

function identityBindingOf(resolved: ResolvedTargetProfile): IdentityBinding {
  return {
    host: resolved.host,
    port: resolved.port,
    username: resolved.username,
    hostKey: resolved.hostKey,
    deviceId: resolved.deviceId,
    boardId: resolved.boardId,
    socId: resolved.socId,
  };
}

function sameBinding(a: IdentityBinding | undefined, b: IdentityBinding): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Pin mismatches and descriptor mismatches are statements about which board
 *  is in front of us — they invalidate the binding. Connectivity and auth
 *  failures are statements about the network and keep it. */
function isIdentityFailure(error: unknown): boolean {
  return (
    error instanceof BetelgeuzError &&
    (error.code === "ssh.hostkey-mismatch" ||
      error.code === "identity.descriptor-mismatch" ||
      error.code === "identity.instance-changed")
  );
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
function authenticationFor(secrets: CredentialSecrets, credentialRef: string): Authentication {
  const material = secrets[credentialRef];
  if (material == null) {
    throw new BetelgeuzError("ssh.auth-failed", {
      detail: `credential material for \`${credentialRef}\` was not supplied or was already used`,
    });
  }
  delete secrets[credentialRef];
  if (material.privateKey != null) {
    if (material.password != null) {
      throw invalidCredentialMaterial();
    }
    return {
      kind: "privateKey",
      privateKey: new Secret(material.privateKey),
      passphrase:
        material.passphrase == null ? undefined : new Secret(material.passphrase),
    };
  }
  if (material.password == null || material.passphrase != null) {
    throw invalidCredentialMaterial();
  }
  return { kind: "password", password: new Secret(material.password) };
}

function invalidCredentialMaterial(): BetelgeuzError {
  return new BetelgeuzError("ssh.auth-failed", {
    detail: "credential material must contain exactly one supported authentication method",
  });
}

function proxyOptions(
  hop: ProxyHopProfile,
  authentication: Authentication,
  hostKeyPin: HostKeyFingerprint
): SshProxyHop {
  return {
    endpoint: {
      host: hop.host,
      port: hop.port ?? 22,
      username: hop.username,
    },
    authentication,
    hostKeyPin,
  };
}

function wipeAuthentication(authentication: Authentication): void {
  if (authentication.kind === "password") {
    authentication.password.wipe();
    return;
  }
  authentication.privateKey.wipe();
  authentication.passphrase?.wipe();
}
