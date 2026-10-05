import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { BetelgeuzError, isBetelgeuzError } from "../errors";
import {
  LinuxRemoteprocStrategy,
  type RemoteCoreState,
} from "../strategies/remoteproc";
import { Secret } from "../secret";
import {
  ExecHandle,
  ExecRequest,
  HostKeyFingerprint,
  type ExecEvent,
  type ExecRequest as ExecRequestType,
} from "../transport";
import { FakeSshTransport } from "../transport/fake";
import type { LinuxRemoteprocConfiguration, ArtifactRecord } from "../protocol";

const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INSTANCE = "30070000.remoteproc";

/** A minimal riscv64 ELF header: the small core is the RISC-V C906 on the
 *  Tier 1 board, and the strategy only checks that the header parses. */
function minimalRiscvElf(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(243, 18);
  bytes.writeUInt16LE(64, 54);
  return bytes;
}

function configuration(
  overrides: Partial<LinuxRemoteprocConfiguration> = {}
): LinuxRemoteprocConfiguration {
  return {
    firmwarePath: "/lib/firmware/rtos.elf",
    instance: INSTANCE,
    ...overrides,
  };
}

async function artifactRecord(): Promise<ArtifactRecord> {
  const directory = await mkdtemp(join(tmpdir(), "betelgeuz-rproc-"));
  const path = join(directory, "rtos.elf");
  const bytes = minimalRiscvElf();
  await writeFile(path, bytes);
  return {
    configuration: "Debug",
    contentHash: "not-used-by-the-strategy",
    path,
    size: bytes.length,
    targetName: "rtos_firmware",
  };
}

async function connected(): Promise<FakeSshTransport> {
  const transport = new FakeSshTransport();
  await transport.connect({
    endpoint: { host: "board.local", port: 22, username: "root" },
    authentication: { kind: "password", password: new Secret("test") },
    hostKeyPin: HostKeyFingerprint.parse(PIN),
    proxyChain: [],
    keepaliveSeconds: 30,
  });
  return transport;
}

/** Records the commands the strategy renders, on top of the simulator. */
class RecordingTransport extends FakeSshTransport {
  readonly commands: Array<string> = [];

  override async exec(request: ExecRequestType): Promise<ExecHandle> {
    this.commands.push(request.command);
    return await super.exec(request);
  }
}

function commandOf(kind: Parameters<typeof ExecRequest.fixed>[0]): string {
  return ExecRequest.fixed(kind).command;
}

function instanceTable(...instances: Array<{ firmware: string; name: string; state: string }>): Array<ExecEvent> {
  const table = instances
    .map((instance, index) =>
      [
        `/sys/class/remoteproc/remoteproc${index}`,
        instance.name,
        instance.state,
        instance.firmware,
        "yes",
      ].join("\t")
    )
    .map((line) => `${line}\n`)
    .join("");
  return [
    { kind: "output", stream: "stdout", bytes: Buffer.from(table) },
    { kind: "exit", status: 0 },
  ];
}

describe("linux.remoteproc strategy", () => {
  it("validates the configured instance and settles direct writes", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "running" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.validate(configuration())).resolves.toBeUndefined();
    // The instance is writable, so no privilege fallback is needed.
    await expect(
      strategy.deploy(await artifactRecord(), configuration(), { stopRunningTarget: true })
    ).resolves.toMatchObject({ remotePath: "/lib/firmware/rtos.elf" });
  });

  it("reports an unsupported target when no instance matches, keeping the attach", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: "other.remoteproc" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    // The incompatibility is a report, not a discard: the strategy instance
    // stays usable and the attach survives it (plan §3).
    await expect(strategy.validate(configuration())).rejects.toMatchObject({
      code: "rproc.instance-missing",
    });
    transport.setRemoteprocInstances([{ name: INSTANCE }]);
    await expect(strategy.validate(configuration())).resolves.toBeUndefined();
  });

  it("resolves the remoteprocN index convenience to the instance's name", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.validate(configuration({ instance: "remoteproc0" }))).resolves.toBeUndefined();
    // The bind is to the resolved name, so a later lookup of that name finding
    // nothing is an identity failure rather than a silent re-target.
    transport.setRemoteprocInstances([{ name: "another.remoteproc" }]);
    await expect(strategy.assertIdentity()).rejects.toMatchObject({
      code: "identity.instance-changed",
    });
  });

  it("stages, stops, commits, selects, and starts in order", async () => {
    const transport = new RecordingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    transport.setRemoteprocInstances([
      { name: INSTANCE, firmware: "/lib/firmware/rtos.elf", state: "running" },
    ]);
    await transport.upload(Readable.from([Buffer.from("previous-firmware")]), "/lib/firmware/rtos.elf");
    const artifact = await artifactRecord();
    const strategy = new LinuxRemoteprocStrategy(transport);

    const result = await strategy.deploy(artifact, configuration(), {
      stopRunningTarget: true,
    });

    expect(result).toEqual({
      previousSize: Buffer.byteLength("previous-firmware"),
      remotePath: "/lib/firmware/rtos.elf",
    });
    // The staged file became the firmware, selected and running.
    expect(transport.remoteFile("/lib/firmware/rtos.elf")).toEqual(minimalRiscvElf());
    expect(await transport.metadata("/lib/firmware/rtos.elf.betelgeuz-prev-1")).not.toBeNull();
    // Stop happened before the commit and start after it (plan §6 stages).
    const stop = transport.commands.findIndex((command) =>
      command.includes(`tee "$d/state"`) && command.includes("'stop'")
    );
    const select = transport.commands.findIndex((command) =>
      command.includes(`tee "$d/firmware"`)
    );
    const start = transport.commands.findIndex((command) =>
      command.includes(`tee "$d/state"`) && command.includes("'start'")
    );
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(select);
    // Nothing staged was left behind.
    expect([...transport.remoteFiles()].some((path) => path.includes(".tmp"))).toBe(false);
  });

  it("refuses to stop a running core without the user's confirmation", async () => {
    const transport = new RecordingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "running" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(
      strategy.deploy(await artifactRecord(), configuration())
    ).rejects.toMatchObject({ code: "operation.cancelled" });
    // Nothing was uploaded, stopped, or selected.
    expect(transport.commands.some((command) => command.includes(`tee "$d/`))).toBe(false);
    expect(await transport.metadata("/lib/firmware/rtos.elf")).toBeNull();
  });

  it("deploys over a stopped core without stopping it", async () => {
    const transport = new RecordingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.deploy(await artifactRecord(), configuration())).resolves.toMatchObject({
      remotePath: "/lib/firmware/rtos.elf",
    });
    expect(transport.commands.some((command) => command.includes("'stop'"))).toBe(false);
  });

  it("fails a non-ELF image before the target is touched", async () => {
    const transport = new RecordingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-rproc-raw-"));
    const path = join(directory, "rtos.bin");
    await writeFile(path, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(
      strategy.deploy(
        {
          configuration: "Debug",
          contentHash: "raw",
          path,
          size: 10,
          targetName: "rtos_firmware",
        },
        configuration()
      )
    ).rejects.toMatchObject({ code: "artifact.arch-mismatch" });
    expect(transport.commands.some((command) => command.includes("remoteproc"))).toBe(false);
  });

  it("cleans up staging and leaves the core running when an upload is interrupted", async () => {
    class CancellingUploadTransport extends FakeSshTransport {
      readonly staged: Array<string> = [];
      readonly removed: Array<string> = [];
      private readonly controller = new AbortController();

      override async upload(
        source: Readable,
        remotePath: string,
        _signal?: AbortSignal
      ): Promise<void> {
        this.staged.push(remotePath);
        this.controller.abort("cancelled mid-upload");
        throw new BetelgeuzError("deploy.upload-failed", {
          cause: new Error("connection reset"),
        });
      }

      override async remove(path: string): Promise<void> {
        this.removed.push(path);
        await super.remove(path);
      }

      get aborted(): AbortSignal {
        return this.controller.signal;
      }
    }
    const transport = new CancellingUploadTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "running" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(
      strategy.deploy(await artifactRecord(), configuration(), {
        stopRunningTarget: true,
        signal: transport.aborted,
      })
    ).rejects.toMatchObject({ code: "deploy.cancelled" });

    // The staging file is gone, nothing was activated, and the core — never
    // stopped — is still running.
    expect(transport.removed).toEqual(transport.staged);
    expect(await transport.metadata("/lib/firmware/rtos.elf")).toBeNull();
    expect(await strategy.inspect(configuration())).toMatchObject({ state: "running" });
  });

  it("aborts without touching the firmware when the stop fails", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "running" }]);
    const stop = commandOf({
      kind: "writeRemoteprocState",
      instance: INSTANCE,
      value: "stop",
      privileged: false,
    });
    transport.setExecEvents(stop, [{ kind: "exit", status: 1 }]);
    const artifact = await artifactRecord();
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(
      strategy.deploy(artifact, configuration(), { stopRunningTarget: true })
    ).rejects.toMatchObject({ code: "rproc.stop-failed" });
    expect(await transport.metadata("/lib/firmware/rtos.elf")).toBeNull();
  });

  it("reports a crash with the kernel log tail", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const start = commandOf({
      kind: "writeRemoteprocState",
      instance: INSTANCE,
      value: "start",
      privileged: false,
    });
    // The start is accepted, but the core reports crashed.
    transport.setExecEvents(start, [{ kind: "exit", status: 0 }]);
    transport.setExecEvents(commandOf({ kind: "readRemoteprocInstances" }), [
      ...instanceTable({ name: INSTANCE, state: "crashed", firmware: "" }),
    ]);
    transport.setExecEvents(commandOf({ kind: "readKernelLogTail" }), [
      { kind: "output", stream: "stdout", bytes: Buffer.from("remoteproc: crashed\n") },
      { kind: "exit", status: 0 },
    ]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    const failure = await strategy.start(configuration()).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "rproc.crashed",
      targetState: "crashed",
    });
    // The kernel log tail rides along as the logged cause.
    expect(isBetelgeuzError(failure) ? failure.causeText : "").toContain(
      "remoteproc: crashed"
    );
  });

  it("reports the last observed state when a transition times out", async () => {
    vi.useFakeTimers();
    try {
      const transport = await connected();
      transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
      const start = commandOf({
        kind: "writeRemoteprocState",
        instance: INSTANCE,
        value: "start",
        privileged: false,
      });
      transport.setExecEvents(start, [{ kind: "exit", status: 0 }]);
      const strategy = new LinuxRemoteprocStrategy(transport);

      const started = strategy.start(configuration());
      const assertion = expect(started).rejects.toMatchObject({
        code: "rproc.state-timeout",
        targetState: "offline",
      });
      await vi.advanceTimersByTimeAsync(31_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes through the sudo whitelist when the account cannot write directly", async () => {
    const transport = new RecordingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    transport.setRemoteprocInstances([
      { name: INSTANCE, state: "offline", writable: false },
    ]);
    transport.setPasswordlessSudo(true);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.deploy(await artifactRecord(), configuration())).resolves.toMatchObject({
      remotePath: "/lib/firmware/rtos.elf",
    });
    const controlWrites = transport.commands.filter((command) => command.includes(`tee "$d/`));
    expect(controlWrites.length).toBeGreaterThan(0);
    expect(controlWrites.every((command) => command.includes("sudo -n tee"))).toBe(true);
  });

  it("reports a missing privilege when neither write path is available", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([
      { name: INSTANCE, state: "offline", writable: false },
    ]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.validate(configuration())).rejects.toMatchObject({
      code: "privilege.denied",
    });
  });

  it("inspects the core as execution state with its selected firmware", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([
      { name: INSTANCE, firmware: "/lib/firmware/rtos.elf", state: "running" },
    ]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    // The exact shape is the assertion: a running state carries no health
    // claim, only what the target reported (plan §6).
    await expect(strategy.inspect(configuration())).resolves.toEqual({
      detail: `${INSTANCE}; firmware /lib/firmware/rtos.elf`,
      state: "running",
    });
  });

  it("surfaces the kernel trace as logs, once", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "running" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.logs(configuration())).resolves.toEqual({ chunks: [] });

    transport.setExecEvents(
      commandOf({ kind: "readRemoteprocTrace", instance: INSTANCE }),
      [
        { kind: "output", stream: "stdout", bytes: Buffer.from("trace line\n") },
        { kind: "exit", status: 0 },
      ]
    );
    const page = await strategy.logs(configuration());
    expect(page.chunks.map((chunk) => Buffer.from(chunk.bytes).toString())).toEqual([
      "trace line\n",
    ]);
    // The trace is not cursor-addressable: a cursor means already delivered.
    await expect(strategy.logs(configuration(), "0")).resolves.toEqual({ chunks: [] });
  });

  it("starts, stops through the state, and settles the run", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    const run = await strategy.start(configuration());
    expect(run.runId).toMatch(/^rproc-run-/);
    await expect(strategy.inspect(configuration())).resolves.toMatchObject({ state: "running" });

    await expect(strategy.stop(configuration())).resolves.toBeUndefined();
    await expect(run.completion).resolves.toEqual({});
    await expect(strategy.inspect(configuration())).resolves.toMatchObject({ state: "stopped" });
  });

  it("restores the retained previous firmware and starts the core", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);
    await strategy.deploy(await artifactRecord(), configuration());
    await strategy.deploy(await artifactRecord(), configuration(), {
      stopRunningTarget: true,
    });

    await expect(strategy.restorePrevious(configuration())).resolves.toBeUndefined();
    // The retained image was selected — the firmware attribute takes a NAME,
    // resolved by the kernel through its search paths — and the core started.
    await expect(strategy.inspect(configuration())).resolves.toMatchObject({
      detail: `${INSTANCE}; firmware rtos.elf.betelgeuz-prev-1`,
      state: "running",
    });
  });

  it("reports an unavailable restore when nothing is retained", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.restorePrevious(configuration())).rejects.toMatchObject({
      code: "artifact.missing",
    });
  });

  it("refuses a second mutating operation while one runs", async () => {
    class ControlledTransport extends FakeSshTransport {
      private releaseUpload?: () => void;

      override async upload(source: Readable, remotePath: string): Promise<void> {
        await new Promise<void>((resolve) => {
          this.releaseUpload = resolve;
        });
        await super.upload(source, remotePath);
      }

      release(): void {
        this.releaseUpload?.();
      }
    }
    const transport = new ControlledTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);

    const first = strategy.deploy(await artifactRecord(), configuration());
    await Promise.resolve();
    await expect(strategy.deploy(await artifactRecord(), configuration())).rejects.toMatchObject({
      code: "deploy.busy",
    });
    transport.release();
    await expect(first).resolves.toMatchObject({ remotePath: "/lib/firmware/rtos.elf" });
  });

  it("keeps the bound identity across operations and detects a re-target", async () => {
    const transport = await connected();
    transport.setRemoteprocInstances([{ name: INSTANCE, state: "offline" }]);
    const strategy = new LinuxRemoteprocStrategy(transport);
    // Bound through the index convenience, so the attach holds the resolved
    // name — not the index the settings happen to spell.
    await strategy.validate(configuration({ instance: "remoteproc0" }));

    // The board now exposes a different core at that index: the resolved name
    // moved, which is an identity failure, never a silent re-target.
    transport.setRemoteprocInstances([{ name: "another.remoteproc", state: "offline" }]);
    await expect(
      strategy.inspect(configuration({ instance: "remoteproc0" }))
    ).rejects.toMatchObject({ code: "identity.instance-changed" });
  });

  it("validates its own configuration before touching the target", async () => {
    const transport = await connected();
    const strategy = new LinuxRemoteprocStrategy(transport);

    await expect(strategy.validate({})).rejects.toMatchObject({ code: "config.invalid" });
    await expect(
      strategy.validate({ instance: "bad name/../x", firmwarePath: "/lib/firmware/x.elf" })
    ).rejects.toMatchObject({ code: "config.invalid" });
    await expect(
      strategy.validate({ instance: INSTANCE, firmwarePath: "lib/firmware/x.elf" })
    ).rejects.toMatchObject({ code: "config.invalid" });
  });

  it("maps the kernel states onto the strategy's vocabulary", async () => {
    const cases: Array<[string, RemoteCoreState]> = [
      ["offline", "stopped"],
      ["running", "running"],
      ["crashed", "crashed"],
      ["suspended", "suspended"],
      ["", "unknown"],
    ];
    for (const [kernel, reported] of cases) {
      const transport = await connected();
      transport.setRemoteprocInstances([{ name: INSTANCE, state: kernel }]);
      const strategy = new LinuxRemoteprocStrategy(transport);
      await expect(strategy.inspect(configuration())).resolves.toMatchObject({ state: reported });
    }
  });
});
