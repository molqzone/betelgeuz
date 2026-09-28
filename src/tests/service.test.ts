import { describe, expect, it } from "vitest";

import { CoreService } from "../service";
import { FakeSshTransport } from "../transport/fake";
import { HostKeyFingerprint } from "../transport";
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
    const service = new CoreService(new FakeSshTransport());
    const result = await service.attach(request());
    expect(result.state).toBe("attached");
    expect(result.attachId).toBe("attach-1");
    expect(result.profile.hostKeyPinned).toBe(true);
    expect(result.identity.hostKeyFingerprint).toBe(PIN);
    expect(JSON.stringify(result)).not.toContain("one-use-secret");
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
});
