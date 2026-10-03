import { describe, expect, it, vi } from "vitest";

import { CoreService } from "../service";
import { FakeSshTransport } from "../transport/fake";
import {
  ExecHandle,
  ExecRequest,
  HostKeyFingerprint,
  type Authentication,
  type SshConnectOptions,
} from "../transport";
import type { AttachRequest, ProfileCatalog } from "../protocol";

const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_PIN = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function request(overrides: Partial<AttachRequest> = {}): AttachRequest {
  return {
    catalog: {},
    target: {
      host: "board.local",
      username: "root",
      credentialRef: "board",
      hostKey: PIN,
    },
    strategyId: "linux.ssh-app",
    credentialSecrets: { board: { password: "one-use-secret" } },
    ...overrides,
  };
}

const PROFILE_PARAMS = {
  catalog: {} as ProfileCatalog,
  target: { host: "board.local", username: "root", credentialRef: "board" },
};

describe("CoreService", () => {
  it("attaches through the transport without echoing secrets", async () => {
    const transport = new FakeSshTransport();
    transport.setDescriptor({ deviceId: "board-1", socId: "rk3506", model: "RVNano" });
    const service = new CoreService(transport);
    const result = await service.attach(request());
    expect(result.state).toBe("attached");
    expect(result.attachId).toBe("attach-1");
    expect(result.profile.hostKeyPinned).toBe(true);
    expect(result.identity.hostKeyFingerprint).toBe(PIN);
    expect(result.identity.descriptor).toEqual({
      deviceId: "board-1",
      socId: "rk3506",
      model: "RVNano",
    });
    expect(JSON.stringify(result)).not.toContain("one-use-secret");
  });

  it("supports a one-use private-key credential and wipes it after connection", async () => {
    class CapturingTransport extends FakeSshTransport {
      authentication?: Authentication;

      override async connect(options: SshConnectOptions): Promise<void> {
        this.authentication = options.authentication;
        await super.connect(options);
      }
    }

    const transport = new CapturingTransport();
    const service = new CoreService(transport);
    await service.attach(
      request({
        credentialSecrets: {
          board: { privateKey: "private-key-material", passphrase: "key-passphrase" },
        },
      })
    );
    expect(transport.authentication?.kind).toBe("privateKey");
    if (transport.authentication?.kind === "privateKey") {
      expect(transport.authentication.privateKey.expose()).toBe("");
      expect(transport.authentication.passphrase?.expose()).toBe("");
    }
  });

  it("rejects a descriptor that disagrees with a configured identity pin", async () => {
    const transport = new FakeSshTransport();
    transport.setDescriptor({ deviceId: "other-board" });
    const service = new CoreService(transport);
    await expect(
      service.attach(
        request({
          target: {
            host: "board.local",
            username: "root",
            credentialRef: "board",
            hostKey: PIN,
            deviceId: "expected-board",
          },
        })
      )
    ).rejects.toMatchObject({ code: "identity.descriptor-mismatch" });
    await expect(service.disconnect({ attachId: "attach-1" })).resolves.toEqual({
      state: "disconnected",
    });
  });

  it("closes the SSH session when descriptor reading times out", async () => {
    class StalledTransport extends FakeSshTransport {
      closed = false;
      terminationRequested = false;

      override async exec(_request: ExecRequest): Promise<ExecHandle> {
        return new ExecHandle(() => {
          this.terminationRequested = true;
          return new Promise<void>(() => undefined);
        });
      }

      override async close(): Promise<void> {
        this.closed = true;
        await super.close();
      }
    }

    vi.useFakeTimers();
    const transport = new StalledTransport();
    try {
      const attach = new CoreService(transport).attach(request());
      const rejection = expect(attach).rejects.toMatchObject({
        code: "identity.descriptor-timeout",
      });
      await vi.advanceTimersByTimeAsync(10_001);
      await vi.advanceTimersByTimeAsync(251);
      await rejection;
      expect(transport.terminationRequested).toBe(true);
      expect(transport.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the SSH session when the descriptor probe is cancelled", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    class StalledTransport extends FakeSshTransport {
      closed = false;
      terminationRequested = false;

      override async exec(_request: ExecRequest): Promise<ExecHandle> {
        markStarted?.();
        return new ExecHandle(() => {
          this.terminationRequested = true;
        });
      }

      override async close(): Promise<void> {
        this.closed = true;
        await super.close();
      }
    }

    const transport = new StalledTransport();
    const controller = new AbortController();
    const attach = new CoreService(transport).attach(request(), controller.signal);
    await started;
    await Promise.resolve();
    controller.abort("user cancelled");
    await expect(attach).rejects.toMatchObject({
      code: "operation.cancelled",
      phase: "identity",
    });
    expect(transport.terminationRequested).toBe(true);
    expect(transport.closed).toBe(true);
  });

  it("requires host-key enrollment before attach", async () => {
    const service = new CoreService(new FakeSshTransport());
    await expect(
      service.attach(request({ target: { host: "board.local", username: "root", credentialRef: "board" } }))
    ).rejects.toMatchObject({ code: "ssh.hostkey-mismatch" });
  });

  it("rejects an observed key that does not match the pin", async () => {
    const transport = new FakeSshTransport();
    transport.setHostKey(HostKeyFingerprint.parse(OTHER_PIN));
    const service = new CoreService(transport);
    await expect(service.attach(request())).rejects.toMatchObject({
      code: "ssh.hostkey-mismatch",
    });
  });

  it("reports unreachable endpoints distinctly", async () => {
    const transport = new FakeSshTransport();
    transport.setConnectFailure(true);
    const service = new CoreService(transport);
    await expect(service.attach(request())).rejects.toMatchObject({
      code: "ssh.unreachable",
    });
  });

  it("allows one active attach at a time", async () => {
    const service = new CoreService(new FakeSshTransport());
    await service.attach(request());
    await expect(service.attach(request())).rejects.toMatchObject({
      code: "deploy.busy",
    });
  });

  it("disconnects the named attach and rejects stale references", async () => {
    const service = new CoreService(new FakeSshTransport());
    const attached = await service.attach(request());
    await expect(
      service.disconnect({ attachId: "attach-999" })
    ).rejects.toMatchObject({ code: "identity.instance-changed" });
    expect(await service.disconnect({ attachId: attached.attachId })).toEqual({
      state: "disconnected",
    });
    // Idempotent when nothing is attached.
    expect(await service.disconnect({ attachId: "anything" })).toEqual({
      state: "disconnected",
    });
  });

  it("abandons an attach whose session was lost so the next attach can bind", async () => {
    const transport = new FakeSshTransport();
    transport.setDescriptor({ deviceId: "board-1" });
    const service = new CoreService(transport);
    await service.attach(request());
    transport.dropConnection("ssh.lost", "cable pulled");

    expect(await service.abandonAttach()).toEqual({ state: "disconnected" });
    expect(await service.attach(request())).toMatchObject({
      attachId: "attach-2",
      state: "attached",
    });
  });

  it("probes host keys before any session exists", async () => {
    const transport = new FakeSshTransport();
    const service = new CoreService(transport);
    const probed = await service.inspectHostKey({
      catalog: {},
      target: PROFILE_PARAMS.target,
    });
    expect(probed.hostKeyFingerprint).toBe(PIN);
    expect(service.resolveProfile(PROFILE_PARAMS).profile.hostKeyPinned).toBe(false);
  });

  it("reconnects the same attach after a drop, keeping its identity", async () => {
    const transport = new FakeSshTransport();
    transport.setDescriptor({ deviceId: "board-1" });
    const service = new CoreService(transport);
    const attached = await service.attach(request());
    transport.dropConnection("ssh.lost", "cable pulled");

    const reconnected = await service.reconnect({
      attachId: attached.attachId,
      catalog: {},
      target: request().target,
      credentialSecrets: { board: { password: "fresh-secret" } },
    });

    expect(reconnected.attachId).toBe("attach-1");
    expect(reconnected.state).toBe("attached");
    expect(reconnected.strategyId).toBe("linux.ssh-app");
    expect(reconnected.identity.descriptor).toEqual({ deviceId: "board-1" });
  });

  it("reports the foreground run's reconciled state after a reconnect", async () => {
    const transport = new FakeSshTransport();
    transport.setDescriptor({ deviceId: "board-1" });
    const service = new CoreService(transport);
    const attached = await service.attach(request());
    const runCommand = ExecRequest.launch({
      executable: "/opt/app",
      argv: [],
      cwd: "/opt",
      environment: {},
      allocatePty: false,
    }).command;
    transport.setExecEvents(runCommand, [
      { kind: "output", stream: "stdout", bytes: Buffer.from("betelgeuz-pid\t4242\n") },
      // No exit event: the channel dies before the process reports.
    ]);
    const run = await service.start({
      attachId: attached.attachId,
      configuration: { remotePath: "/opt/app" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.dropConnection("ssh.lost", "cable pulled");

    await service.reconnect({
      attachId: attached.attachId,
      catalog: {},
      target: request().target,
      credentialSecrets: { board: { password: "fresh-secret" } },
    });

    // The status the UI restores is the probed truth — the run ended while its
    // channel was gone, so its details are honestly unobserved.
    await expect(
      service.status({ attachId: attached.attachId })
    ).resolves.toEqual({ state: "exited", outcome: {} });
    await expect(run.completion).resolves.toEqual({});
  });

  it("keeps the attach when reconnect only fails to reach the board", async () => {
    const transport = new FakeSshTransport();
    const service = new CoreService(transport);
    const attached = await service.attach(request());
    transport.dropConnection("ssh.lost", "cable pulled");
    transport.setConnectFailure(true);

    await expect(
      service.reconnect({
        attachId: attached.attachId,
        catalog: {},
        target: request().target,
        credentialSecrets: { board: { password: "fresh-secret" } },
      })
    ).rejects.toMatchObject({ code: "ssh.unreachable" });

    // The binding survives a network failure, so the retry loop can try again
    // without creating a second attach.
    transport.setConnectFailure(false);
    await expect(
      service.reconnect({
        attachId: attached.attachId,
        catalog: {},
        target: request().target,
        credentialSecrets: { board: { password: "retry-secret" } },
      })
    ).resolves.toMatchObject({ attachId: "attach-1", state: "attached" });
  });

  it("invalidates the attach when revalidation sees a different host key", async () => {
    const transport = new FakeSshTransport();
    const service = new CoreService(transport);
    const attached = await service.attach(request());
    transport.dropConnection("ssh.lost", "cable pulled");
    transport.setHostKey(HostKeyFingerprint.parse(OTHER_PIN));

    await expect(
      service.reconnect({
        attachId: attached.attachId,
        catalog: {},
        target: request().target,
        credentialSecrets: { board: { password: "fresh-secret" } },
      })
    ).rejects.toMatchObject({ code: "ssh.hostkey-mismatch" });

    // The old binding is gone: a new handshake binds a new attach.
    transport.setHostKey(HostKeyFingerprint.parse(PIN));
    await expect(service.attach(request())).resolves.toMatchObject({
      attachId: "attach-2",
      state: "attached",
    });
  });

  it("invalidates the attach when revalidation sees a different board", async () => {
    const transport = new FakeSshTransport();
    transport.setDescriptor({ deviceId: "board-1" });
    const service = new CoreService(transport);
    const attached = await service.attach(
      request({
        target: {
          host: "board.local",
          username: "root",
          credentialRef: "board",
          hostKey: PIN,
          deviceId: "board-1",
        },
      })
    );
    transport.dropConnection("ssh.lost", "cable pulled");
    transport.setDescriptor({ deviceId: "board-2" });

    await expect(
      service.reconnect({
        attachId: attached.attachId,
        catalog: {},
        target: {
          host: "board.local",
          username: "root",
          credentialRef: "board",
          hostKey: PIN,
          deviceId: "board-1",
        },
        credentialSecrets: { board: { password: "fresh-secret" } },
      })
    ).rejects.toMatchObject({ code: "identity.descriptor-mismatch" });

    await expect(service.attach(request())).resolves.toMatchObject({
      attachId: "attach-2",
    });
  });

  it("invalidates the attach when the configured identity changed since binding", async () => {
    const transport = new FakeSshTransport();
    const service = new CoreService(transport);
    const attached = await service.attach(request());
    transport.dropConnection("ssh.lost", "cable pulled");

    await expect(
      service.reconnect({
        attachId: attached.attachId,
        catalog: {},
        target: {
          host: "board.local",
          username: "root",
          credentialRef: "board",
          hostKey: PIN,
          deviceId: "board-1",
        },
        credentialSecrets: { board: { password: "fresh-secret" } },
      })
    ).rejects.toMatchObject({ code: "identity.instance-changed" });

    await expect(service.attach(request())).resolves.toMatchObject({
      attachId: "attach-2",
    });
  });

  it("rejects a reconnect naming an attach that is not active", async () => {
    const service = new CoreService(new FakeSshTransport());
    await expect(
      service.reconnect({
        attachId: "attach-999",
        catalog: {},
        target: request().target,
        credentialSecrets: { board: { password: "fresh-secret" } },
      })
    ).rejects.toMatchObject({ code: "identity.instance-changed" });
  });
});
