import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { BetelgeuzError } from "../errors";
import { SshApplicationStrategy } from "../strategies/ssh-app";
import { Secret } from "../secret";
import {
  ExecHandle,
  ExecRequest,
  HostKeyFingerprint,
  type ExecEvent,
} from "../transport";
import { FakeSshTransport } from "../transport/fake";

const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function minimalAarch64Elf(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(183, 18);
  bytes.writeUInt16LE(64, 54);
  return bytes;
}

async function connected(): Promise<FakeSshTransport> {
  const transport = new FakeSshTransport();
  await transport.connect({
    endpoint: { host: "board.local", port: 22, username: "root" },
    authentication: {
      kind: "password",
      // The fake does not inspect this value; the test only needs a typed
      // connected session.
      password: new Secret("test"),
    },
    hostKeyPin: HostKeyFingerprint.parse(PIN),
    proxyChain: [],
    keepaliveSeconds: 30,
  });
  return transport;
}

describe("linux.ssh-app strategy", () => {
  it("uploads to a staging path and atomically activates the artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-strategy-"));
    const path = join(directory, "app");
    const artifactBytes = minimalAarch64Elf();
    await writeFile(path, artifactBytes);
    const transport = await connected();
    const strategy = new SshApplicationStrategy(transport);

    const result = await strategy.deploy(
      {
        configuration: "Debug",
        contentHash: "not-used-by-phase-1",
        path,
        size: artifactBytes.length,
        targetName: "app",
      },
      { remotePath: "/opt/app", fileMode: "0755" }
    );

    expect(result.remotePath).toBe("/opt/app");
    expect(transport.remoteFile("/opt/app")).toEqual(artifactBytes);
    expect(await transport.metadata("/opt/app")).toMatchObject({ mode: 0o755 });
  });

  it("streams structured output and keeps a cursor-addressable ring", async () => {
    const transport = await connected();
    const request = "cd '/opt' && MODE='test' exec '/opt/app' '--name=bob'";
    transport.setExecEvents(request, [
      { kind: "output", stream: "stdout", bytes: Buffer.from("ready\n") },
      { kind: "output", stream: "stderr", bytes: Buffer.from("warning\n") },
      { kind: "exit", status: 7 },
    ]);
    const strategy = new SshApplicationStrategy(transport);
    const output: Array<string> = [];
    const run = await strategy.start(
      {
        remotePath: "/opt/app",
        executable: "/opt/app",
        args: ["--name=bob"],
        cwd: "/opt",
        environment: { MODE: "test" },
      },
      (chunk) => output.push(`${chunk.stream}:${Buffer.from(chunk.bytes).toString()}`)
    );

    await expect(run.completion).resolves.toEqual({ status: 7 });
    expect(output).toEqual(["stdout:ready\n", "stderr:warning\n"]);
    expect(strategy.status()).toEqual({ state: "exited", outcome: { status: 7 } });
    expect(strategy.logs()).toMatchObject({
      chunks: [
        { stream: "stdout", bytes: Array.from(Buffer.from("ready\n")) },
        { stream: "stderr", bytes: Array.from(Buffer.from("warning\n")) },
      ],
    });
  });

  it("fails preflight before staging on a read-only destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-strategy-"));
    const path = join(directory, "app");
    const artifactBytes = minimalAarch64Elf();
    await writeFile(path, artifactBytes);
    const transport = await connected();
    const preflight = ExecRequest.fixed({
      kind: "preflightDestination",
      directory: "/opt",
    });
    transport.setExecEvents(preflight.command, [
      {
        kind: "output",
        stream: "stdout",
        bytes: Buffer.from("writable\tno\nfreeBytes\t104857600\nnoexec\tno\n"),
      },
      { kind: "exit", status: 0 },
    ]);

    await expect(new SshApplicationStrategy(transport).deploy(
      {
        configuration: "Debug",
        contentHash: "not-used-by-phase-1",
        path,
        size: artifactBytes.length,
        targetName: "app",
      },
      { remotePath: "/opt/app" }
    )).rejects.toMatchObject({ code: "deploy.preflight-failed" });
    expect(await transport.metadata("/opt/app")).toBeNull();
  });

  it("escalates stop after the grace period", async () => {
    class HangingTransport extends FakeSshTransport {
      terminated = false;
      killed = false;

      override async exec(): Promise<ExecHandle> {
        const handle = new ExecHandle(
          () => {
            this.terminated = true;
          },
          () => {
            this.killed = true;
            handle.push({ kind: "exit", signal: "KILL" });
            handle.push(null);
          }
        );
        return handle;
      }
    }
    const transport = new HangingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: {
        kind: "password",
        password: new Secret("test"),
      },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    const strategy = new SshApplicationStrategy(transport);
    const run = await strategy.start({ remotePath: "/opt/app" });
    await expect(strategy.stop(0)).resolves.toEqual({ signal: "KILL" });
    await expect(run.completion).resolves.toEqual({ signal: "KILL" });
    expect(transport.terminated).toBe(true);
    expect(transport.killed).toBe(true);
  });

  it("refuses activation instead of replacing non-atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-refuse-"));
    const path = join(directory, "app");
    const artifactBytes = minimalAarch64Elf();
    await writeFile(path, artifactBytes);
    class RefusingTransport extends FakeSshTransport {
      readonly staged: Array<string> = [];
      readonly removed: Array<string> = [];

      override async upload(
        source: Readable,
        remotePath: string,
        signal?: AbortSignal
      ): Promise<void> {
        this.staged.push(remotePath);
        await super.upload(source, remotePath, signal);
      }

      override async remove(remotePath: string): Promise<void> {
        this.removed.push(remotePath);
        await super.remove(remotePath);
      }

      override async rename(): Promise<void> {
        throw new BetelgeuzError("deploy.activation-unsupported");
      }
    }
    const transport = new RefusingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });

    await expect(new SshApplicationStrategy(transport).deploy(
      {
        configuration: "Debug",
        contentHash: "not-used-by-phase-1",
        path,
        size: artifactBytes.length,
        targetName: "app",
      },
      { remotePath: "/opt/app" }
    )).rejects.toMatchObject({ code: "deploy.activation-unsupported" });

    // Nothing was activated, and the staged file was cleaned up.
    expect(await transport.metadata("/opt/app")).toBeNull();
    expect(transport.staged).toHaveLength(1);
    expect(transport.removed).toEqual(transport.staged);
  });

  it("creates the destination directory before staging into it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-mkdir-"));
    const path = join(directory, "app");
    await writeFile(path, minimalAarch64Elf());
    class RecordingTransport extends FakeSshTransport {
      readonly commands: Array<string> = [];

      override async exec(request: ExecRequest): Promise<ExecHandle> {
        this.commands.push(request.command);
        return await super.exec(request);
      }
    }
    const transport = new RecordingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    const result = await new SshApplicationStrategy(transport).deploy(
      {
        configuration: "Debug",
        contentHash: "not-used-by-phase-1",
        path,
        size: minimalAarch64Elf().length,
        targetName: "app",
      },
      { remotePath: "/opt/nested/app" }
    );

    expect(result.remotePath).toBe("/opt/nested/app");
    const created = transport.commands.indexOf("mkdir -p -- '/opt/nested'");
    const preflighted = transport.commands.findIndex((command) =>
      command.startsWith("printf 'writable\\t'")
    );
    expect(created).toBeGreaterThanOrEqual(0);
    expect(preflighted).toBeGreaterThan(created);
    expect(transport.remoteFile("/opt/nested/app")).toBeDefined();
  });

  it("pages the output ring in whole chunks and never drops a tail", async () => {
    const transport = await connected();
    transport.setExecEvents("cd '/opt' && exec '/opt/app'", [
      { kind: "output", stream: "stdout", bytes: Buffer.from("aaaa") },
      { kind: "output", stream: "stdout", bytes: Buffer.from("bbbb") },
      { kind: "output", stream: "stdout", bytes: Buffer.from("cccc") },
      { kind: "exit", status: 0 },
    ]);
    const strategy = new SshApplicationStrategy(transport);
    const run = await strategy.start({ remotePath: "/opt/app" });
    await expect(run.completion).resolves.toEqual({ status: 0 });

    const first = strategy.logs(undefined, 4);
    expect(first.chunks).toEqual([
      { bytes: Array.from(Buffer.from("aaaa")), stream: "stdout" },
    ]);
    expect(first.nextCursor).toBe("1");
    const second = strategy.logs(first.nextCursor, 4);
    expect(second.chunks).toEqual([
      { bytes: Array.from(Buffer.from("bbbb")), stream: "stdout" },
    ]);
    expect(second.nextCursor).toBe("2");
    const third = strategy.logs(second.nextCursor, 4);
    expect(third.chunks).toEqual([
      { bytes: Array.from(Buffer.from("cccc")), stream: "stdout" },
    ]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("emits at least one chunk when a single one exceeds the page", async () => {
    const transport = await connected();
    transport.setExecEvents("cd '/opt' && exec '/opt/app'", [
      { kind: "output", stream: "stdout", bytes: Buffer.from("0123456789") },
      { kind: "exit", status: 0 },
    ]);
    const strategy = new SshApplicationStrategy(transport);
    const run = await strategy.start({ remotePath: "/opt/app" });
    await expect(run.completion).resolves.toEqual({ status: 0 });

    const page = strategy.logs(undefined, 4);
    expect(page.chunks).toEqual([
      { bytes: Array.from(Buffer.from("0123456789")), stream: "stdout" },
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("clears per-attach history when the session is already gone", async () => {
    const transport = await connected();
    transport.setExecEvents("cd '/opt' && exec '/opt/app'", [
      { kind: "output", stream: "stdout", bytes: Buffer.from("previous session\n") },
      { kind: "exit", status: 3 },
    ]);
    const strategy = new SshApplicationStrategy(transport);
    const run = await strategy.start({ remotePath: "/opt/app" });
    await expect(run.completion).resolves.toEqual({ status: 3 });
    expect(strategy.logs().chunks).toHaveLength(1);

    strategy.resetForcibly();

    expect(strategy.logs()).toEqual({ chunks: [] });
    expect(strategy.status()).toEqual({ state: "stopped" });
  });

  it("lets a run outlive its attach and stops tracking it", async () => {
    class OpenRunTransport extends FakeSshTransport {
      override async exec(): Promise<ExecHandle> {
        // Delivers nothing, so the run stays open like a live foreground app.
        return new ExecHandle(() => undefined, () => undefined);
      }
    }
    const transport = new OpenRunTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    const strategy = new SshApplicationStrategy(transport);
    await strategy.start({ remotePath: "/opt/app" });
    expect(strategy.status()).toEqual({ state: "running" });

    strategy.resetForcibly();

    expect(strategy.status()).toEqual({ state: "stopped" });
    const replacement = await strategy.start({ remotePath: "/opt/app" });
    expect(replacement.runId).toMatch(/^run-/);
    expect(strategy.status()).toEqual({ state: "running" });
  });

  it("keeps the replacement run when the abandoned run settles late", async () => {
    class Run {
      terminated = false;
      readonly handle: ExecHandle;

      constructor() {
        this.handle = new ExecHandle(
          () => {
            this.terminated = true;
            this.handle.push({ kind: "exit", signal: "TERM" });
            this.handle.push(null);
          },
          () => {
            this.handle.push({ kind: "exit", signal: "KILL" });
            this.handle.push(null);
          }
        );
      }

      settle(event: ExecEvent): void {
        this.handle.push(event);
        this.handle.push(null);
      }
    }
    class TrackingTransport extends FakeSshTransport {
      readonly runs: Array<Run> = [];

      override async exec(): Promise<ExecHandle> {
        const run = new Run();
        this.runs.push(run);
        return run.handle;
      }
    }
    const transport = new TrackingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    const strategy = new SshApplicationStrategy(transport);
    await strategy.start({ remotePath: "/opt/app" });
    strategy.resetForcibly();
    await strategy.start({ remotePath: "/opt/app" });

    transport.runs[0].settle({ kind: "exit", signal: "KILL" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(strategy.status()).toEqual({ state: "running" });
    expect(transport.runs[0].terminated).toBe(false);
    await expect(strategy.stop(0)).resolves.toEqual({ signal: "TERM" });
    expect(transport.runs[1].terminated).toBe(true);
  });

  it("keeps a newer mutation protected after an abandoned one releases", async () => {
    class DeployControlledTransport extends FakeSshTransport {
      private readonly reached: Array<Promise<void>> = [];
      private readonly markReached: Array<() => void> = [];
      private readonly releaseUpload: Array<() => void> = [];
      private uploads = 0;

      constructor() {
        super();
        for (let index = 0; index < 2; index += 1) {
          this.reached.push(
            new Promise<void>((resolve) => this.markReached.push(resolve))
          );
          this.releaseUpload.push(() => undefined);
        }
      }

      override async upload(
        source: Readable,
        remotePath: string,
        signal?: AbortSignal
      ): Promise<void> {
        const index = this.uploads;
        this.uploads += 1;
        this.markReached[index]();
        await new Promise<void>((resolve) => {
          this.releaseUpload[index] = resolve;
        });
        return await super.upload(source, remotePath, signal);
      }

      uploadStarted(index: number): Promise<void> {
        return this.reached[index];
      }

      release(upload: number): void {
        this.releaseUpload[upload]();
      }
    }

    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-mutation-"));
    const path = join(directory, "app");
    await writeFile(path, minimalAarch64Elf());
    const artifact = {
      configuration: "Debug",
      contentHash: "not-used-by-phase-1",
      path,
      size: minimalAarch64Elf().length,
      targetName: "app",
    };
    const transport = new DeployControlledTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    const strategy = new SshApplicationStrategy(transport);
    const abandoned = strategy.deploy(artifact, { remotePath: "/opt/app" });
    await transport.uploadStarted(0);
    strategy.resetForcibly();
    const current = strategy.deploy(artifact, { remotePath: "/opt/app" });
    await transport.uploadStarted(1);

    // The abandoned deploy finishes and runs its release, which must not clear
    // the mutation the newer deploy holds.
    transport.release(0);
    await expect(abandoned).resolves.toMatchObject({ remotePath: "/opt/app" });

    await expect(strategy.deploy(artifact, { remotePath: "/opt/app" })).rejects.toMatchObject({
      code: "deploy.busy",
    });
    transport.release(1);
    await expect(current).resolves.toMatchObject({ remotePath: "/opt/app" });
  });

  it("keeps the replacement run when the abandoned run settles late", async () => {
    class Run {
      terminated = false;
      readonly handle: ExecHandle;

      constructor() {
        this.handle = new ExecHandle(
          () => {
            this.terminated = true;
            this.handle.push({ kind: "exit", signal: "TERM" });
            this.handle.push(null);
          },
          () => {
            this.handle.push({ kind: "exit", signal: "KILL" });
            this.handle.push(null);
          }
        );
      }

      settle(event: ExecEvent): void {
        this.handle.push(event);
        this.handle.push(null);
      }
    }
    class TrackingTransport extends FakeSshTransport {
      readonly runs: Array<Run> = [];

      override async exec(): Promise<ExecHandle> {
        const run = new Run();
        this.runs.push(run);
        return run.handle;
      }
    }
    const transport = new TrackingTransport();
    await transport.connect({
      endpoint: { host: "board.local", port: 22, username: "root" },
      authentication: { kind: "password", password: new Secret("test") },
      hostKeyPin: HostKeyFingerprint.parse(PIN),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    const strategy = new SshApplicationStrategy(transport);
    await strategy.start({ remotePath: "/opt/app" });
    strategy.resetForcibly();
    await strategy.start({ remotePath: "/opt/app" });

    transport.runs[0].settle({ kind: "exit", signal: "KILL" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(strategy.status()).toEqual({ state: "running" });
    expect(transport.runs[0].terminated).toBe(false);
    await expect(strategy.stop(0)).resolves.toEqual({ signal: "TERM" });
    expect(transport.runs[1].terminated).toBe(true);
  });

});
