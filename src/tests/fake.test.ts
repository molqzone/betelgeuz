import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { Secret } from "../secret";
import {
  ExecRequest,
  HostKeyFingerprint,
  type SshConnectOptions,
  type SessionLoss,
} from "../transport";
import { FakeSshTransport } from "../transport/fake";

const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function connectOptions(pin = PIN): SshConnectOptions {
  return {
    endpoint: { host: "board.local", port: 22, username: "root" },
    authentication: { kind: "password", password: new Secret("secret") },
    hostKeyPin: HostKeyFingerprint.parse(pin),
    proxyChain: [],
    keepaliveSeconds: 30,
  };
}

describe("FakeSshTransport", () => {
  it("refuses a session when the host-key pin does not match", async () => {
    const transport = new FakeSshTransport();
    await expect(
      transport.connect(connectOptions("SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"))
    ).rejects.toMatchObject({ code: "ssh.hostkey-mismatch" });
  });

  it("streams exec events and performs atomic file operations", async () => {
    const transport = new FakeSshTransport();
    await transport.connect(connectOptions());
    const request = ExecRequest.launch({
      executable: "fixed-launcher",
      argv: [],
      environment: {},
      allocatePty: false,
    });
    transport.setExecEvents(request.command, [
      { kind: "output", stream: "stdout", bytes: Buffer.from("ready") },
      { kind: "exit", status: 0 },
    ]);
    const handle = await transport.exec(request);
    expect(await handle.nextEvent()).toMatchObject({ kind: "output" });
    expect(await handle.nextEvent()).toMatchObject({ kind: "exit", status: 0 });

    await transport.upload(Readable.from([Buffer.from("firmware")]), "/tmp/stage.elf");
    await transport.rename("/tmp/stage.elf", "/lib/firmware/app.elf");
    expect(transport.remoteFile("/lib/firmware/app.elf")?.toString()).toBe("firmware");
    expect(await transport.metadata("/tmp/stage.elf")).toBeNull();
  });

  it("reports the terminating signal and closes the stream", async () => {
    const transport = new FakeSshTransport();
    await transport.connect(connectOptions());
    const request = ExecRequest.fixed({
      kind: "signalProcessGroup",
      pgid: 4242,
      signal: "kill",
    });
    expect(request.command).toBe("kill -KILL -- -4242");
    transport.setExecEvents(request.command, []);
    const handle = await transport.exec(request);
    await handle.terminate();
    expect(await handle.nextEvent()).toMatchObject({
      kind: "exit",
      signal: "TERM",
    });
    expect(await handle.nextEvent()).toBeNull();
  });

  it("reports losses as catalog causes", async () => {
    const transport = new FakeSshTransport();
    const losses: Array<SessionLoss> = [];
    transport.onSessionLoss((loss) => losses.push(loss));
    transport.dropConnection("ssh.lost", "cable pulled");
    expect(losses).toEqual([{ cause: "ssh.lost", detail: "cable pulled" }]);
  });

  it("fails operations after the connection is gone", async () => {
    const transport = new FakeSshTransport();
    await expect(transport.metadata("/x")).rejects.toMatchObject({ code: "ssh.lost" });
  });
});
