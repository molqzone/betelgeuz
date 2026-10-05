/**
 * Linux small-core firmware strategy (`linux.remoteproc`).
 *
 * This module owns the Phase 5 workflow after the shared SSH attach has
 * verified the board (plan §6): the configured `remoteproc` instance is
 * resolved by its stable `name`, the firmware image is staged on the firmware
 * filesystem while the core keeps running, and activation is the commit point
 * — an atomic move into place, a firmware selection, and a state transition
 * the target reports. It deliberately opens no connection of its own, builds
 * no free-form shell command, and never claims a state the target did not
 * report: `running` means Linux started the core, not that the firmware's
 * work is correct.
 *
 * The instance identity is strategy-owned. The setting names a sysfs name, or
 * the `remoteprocN` index convenience that is resolved to a name once and
 * re-validated on every reconnect; a changed or ambiguous name is
 * `identity.instance-changed`, never a silent re-target.
 *
 * The `rproc.*` error definitions live here: each strategy owns its namespaced
 * codes (plan §6), so the common catalog stays unaware of them.
 */
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { verifyArtifactFile } from "../artifact/record";
import { inspectElf } from "../artifact/elf";
import { throwIfAborted } from "../cancellation";
import {
  BetelgeuzError,
  type BetelgeuzErrorContext,
  type ErrorCode,
  type ErrorDef,
} from "../errors";
import {
  MutationLock,
  delay,
  isCancellation,
  parseFields,
  runFixedCommand,
} from "../operation";
import type {
  ArtifactRecord,
  LinuxRemoteprocConfiguration,
  LogsResult,
  OutputChunk,
  RunOutcome,
  StatusResult,
} from "../protocol";
import {
  type DeployOptions,
  type DeployOutcome,
  type DeployStrategy,
  type StrategyRun,
} from "../strategy";
import { ExecRequest, type SshTransport } from "../transport";

/** Poll interval while waiting for a core state transition: the kernel moves
 *  a remoteproc state in milliseconds, so a short poll is honest and cheap. */
const STATE_POLL_MS = 250;

/** Budget for one state transition (stop or start). A core that has not moved
 *  within this budget is reported with its last observed state, never guessed
 *  (E2). */
const STATE_WAIT_TIMEOUT_MS = 30_000;

/** Bounded retained previous firmware count, so recovery cannot silently
 *  exhaust target storage (plan §4). */
const MAX_RETAINED_FIRMWARE = 3;

/** Size budget across the retained set, trimmed from the oldest slot. */
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;

/** The control templates' stdout marker for "the fixed loop matched no
 *  instance" — a race between resolving the instance and writing to it. */
const INSTANCE_MISSING_MARKER = "instance-missing";

export const RPROC_ERRORS = {
  "rproc.instance-missing": {
    phase: "lifecycle",
    retriable: false,
    remediation: "selectSupportedStrategy",
    summary:
      "The board exposes no supported small-core control interface for the configured core.",
  },
  "rproc.stop-failed": {
    phase: "lifecycle",
    retriable: true,
    remediation: "retry",
    summary: "Stopping the small core failed; the deployed firmware is untouched.",
  },
  "rproc.crashed": {
    phase: "lifecycle",
    retriable: false,
    remediation: "restorePreviousVersion",
    summary:
      "The small core entered the crashed state; carries the kernel log tail when readable.",
  },
  "rproc.state-timeout": {
    phase: "lifecycle",
    retriable: true,
    remediation: "inspectTrace",
    summary:
      "Timed out waiting for the core state transition; carries the last observed state.",
  },
} as const satisfies Record<string, ErrorDef>;

export type RemoteprocErrorCode = keyof typeof RPROC_ERRORS;

type RemoteprocErrorContext = Omit<BetelgeuzErrorContext, "definition">;

function rprocError(
  code: RemoteprocErrorCode,
  context: RemoteprocErrorContext = {}
): BetelgeuzError {
  return new BetelgeuzError(code, { ...context, definition: RPROC_ERRORS[code] });
}

/** The target state the core reached, in the strategy's own vocabulary. */
export type RemoteCoreState = "crashed" | "running" | "stopped" | "suspended" | "unknown";

/** One line of the instance table: the directory the fixed loop found, the
 *  stable name it is addressed by, its state, selected firmware, and whether
 *  this account may write the controls directly. */
type InstanceRow = {
  directory: string;
  firmware: string;
  name: string;
  state: string;
  writable: string;
};

/** What one control write reports when the instance is gone, and the code the
 *  write itself fails with — per call site, because the commit point decides
 *  whether a lost instance is an interface failure or a commit failure. */
type ControlWrite = {
  failure: ErrorCode;
  missingFailure: ErrorCode;
  step: string;
};

type PendingRun = {
  settle: (outcome: RunOutcome) => void;
};

export class LinuxRemoteprocStrategy implements DeployStrategy {
  readonly id = "linux.remoteproc";
  readonly role = "small-core";
  private readonly mutation = new MutationLock();
  /** The strategy-owned identity: the instance name this attach is bound to.
   *  Set by the post-bind probe, re-checked on every reconnect. */
  private resolvedName?: string;
  /** Whether the privileged write path is in use for this attach. */
  private privileged = false;
  /** A started core's completion, settled when `stop` succeeds. The core has
   *  no process outcome, so the promise deliberately stays pending while it
   *  runs — a `running` state is not a completion. */
  private pending?: PendingRun;

  constructor(private readonly transport: SshTransport) {}

  /**
   * The post-bind interface probe: parses this strategy's configuration,
   * resolves the configured instance, and settles the privilege mode. An
   * incompatibility is reported here and never discards the attach (Phase 5).
   */
  async validate(configuration: unknown, signal?: AbortSignal): Promise<void> {
    const config = parseRemoteprocConfiguration(configuration);
    const row = await this.resolveInstance(config.instance, "probe", signal);
    this.privileged = await this.privilegeFor(row, signal);
    this.resolvedName = row.name;
  }

  /**
   * Re-checks the strategy-owned identity after a reconnect: the instance this
   * attach bound to must still resolve to the same name. A gone, changed, or
   * ambiguous instance is `identity.instance-changed`.
   */
  async assertIdentity(signal?: AbortSignal): Promise<void> {
    const bound = this.resolvedName;
    if (bound === undefined) {
      return;
    }
    await this.resolveInstance(bound, "assert", signal);
  }

  async deploy(
    artifact: ArtifactRecord,
    configuration: unknown,
    options: DeployOptions = {}
  ): Promise<DeployOutcome> {
    const signal = options.signal;
    const release = this.mutation.enter();
    try {
      throwIfAborted(signal, "deploy");
      const config = parseRemoteprocConfiguration(configuration);
      const source = await verifyArtifactFile(artifact);
      // Format validation before the target is touched at all, so a wrong
      // image fails while the core is still running (plan §6, stage 2). This
      // release declares no raw-binary format key, so the artifact must be an
      // ELF image whose header parses.
      try {
        await inspectElf(source.path, source.size);
      } catch (error) {
        throw new BetelgeuzError("artifact.arch-mismatch", {
          detail: "firmware must be an ELF image; this release declares no raw-binary format",
          cause: error,
        });
      }
      const row = await this.resolveInstance(config.instance, "probe", signal);
      this.retainIdentity(row);
      const privileged = await this.privilegeFor(row, signal);
      // Only a running core can be executing work, so only then does the
      // plan's stop-confirmation rule apply; a crashed or suspended core is
      // stopped without asking.
      if (mapState(row.state) === "running" && options.stopRunningTarget !== true) {
        throw new BetelgeuzError("operation.cancelled", {
          detail: "the small core is running; stopping it must be confirmed before deploy",
          phase: "deploy",
        });
      }
      const firmwareDirectory = dirname(config.firmwarePath);
      await runFixedCommand(
        this.transport,
        ExecRequest.fixed({ kind: "makeDirectory", directory: firmwareDirectory }),
        { failure: failWith("deploy.preflight-failed"), step: "mkdir", signal }
      );
      const preflight = await this.readPreflight(firmwareDirectory, signal);
      // `noexec` is not a failure here: the kernel reads the firmware image,
      // it never executes it from this filesystem.
      if (
        preflight.writable !== true ||
        (preflight.freeBytes !== undefined && preflight.freeBytes < source.size)
      ) {
        throw new BetelgeuzError("deploy.preflight-failed", {
          detail: describeFirmwarePreflight(preflight, source.size),
        });
      }
      // Same directory as the firmware location, therefore the same
      // filesystem: the move into place is atomic and the upload is fully
      // reversible while the core keeps running.
      const stagingPath = `${config.firmwarePath}.betelgeuz-${randomUUID()}.tmp`;
      let committed = false;
      try {
        await this.transport.upload(createReadStream(source.path), stagingPath, signal);
        if (mapState(row.state) !== "stopped") {
          await this.stopAndWait(row.name, privileged, signal);
        }
        const previousSize = await this.retainPrevious(config.firmwarePath, signal);
        // The commit point: from the rename on, cancellation is refused and
        // the operation runs to completion or a definitive failure (plan §6).
        await this.transport.rename(stagingPath, config.firmwarePath);
        committed = true;
        await this.writeFirmware(
          row.name,
          firmwareName(config.firmwarePath),
          privileged,
          {
            failure: "deploy.commit-failed",
            missingFailure: "rproc.instance-missing",
            step: "firmware selection",
          },
          signal
        );
        await this.startAndWait(row.name, privileged, signal);
        return {
          ...(previousSize === undefined ? {} : { previousSize }),
          remotePath: config.firmwarePath,
        };
      } catch (error) {
        if (!committed) {
          await this.removeStaging(stagingPath);
        }
        if (isCancellation(error) || signal?.aborted === true) {
          throw new BetelgeuzError("deploy.cancelled", {
            phase: "deploy",
            cause: error,
          });
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  async start(
    configuration: unknown,
    _onOutput?: (chunk: OutputChunk) => void,
    signal?: AbortSignal
  ): Promise<StrategyRun> {
    const release = this.mutation.enter();
    try {
      const config = parseRemoteprocConfiguration(configuration);
      const row = await this.resolveInstance(config.instance, "probe", signal);
      this.retainIdentity(row);
      const privileged = await this.privilegeFor(row, signal);
      await this.startAndWait(row.name, privileged, signal, row.state);
      return this.run();
    } finally {
      release();
    }
  }

  /** No signal escalation applies: stopping the core is a state transition
   *  the target reports, so `graceMs` is accepted for contract symmetry. A
   *  stop on an already-stopped core is the requested state — and the kernel
   *  refuses the redundant write, so it is skipped. */
  async stop(configuration: unknown, _graceMs?: number): Promise<RunOutcome | undefined> {
    const release = this.mutation.enter();
    try {
      const config = parseRemoteprocConfiguration(configuration);
      const row = await this.resolveInstance(config.instance, "probe", undefined);
      this.retainIdentity(row);
      const privileged = await this.privilegeFor(row, undefined);
      if (mapState(row.state) !== "stopped") {
        await this.stopAndWait(row.name, privileged, undefined);
      }
      const pending = this.pending;
      this.pending = undefined;
      pending?.settle({});
      return undefined;
    } finally {
      release();
    }
  }

  async restart(
    configuration: unknown,
    onOutput?: (chunk: OutputChunk) => void,
    signal?: AbortSignal
  ): Promise<StrategyRun> {
    await this.stop(configuration);
    return await this.start(configuration, onOutput, signal);
  }

  async inspect(configuration: unknown, signal?: AbortSignal): Promise<StatusResult> {
    const config = parseRemoteprocConfiguration(configuration);
    const row = await this.resolveInstance(config.instance, "probe", signal);
    this.retainIdentity(row);
    return {
      detail: `${row.name}; firmware ${row.firmware === "" ? "none" : row.firmware}`,
      state: mapState(row.state),
    };
  }

  async logs(
    configuration: unknown,
    cursor?: string | null,
    _maxBytes?: number
  ): Promise<LogsResult> {
    const config = parseRemoteprocConfiguration(configuration);
    const row = await this.resolveInstance(config.instance, "probe", undefined);
    this.retainIdentity(row);
    if (cursor !== undefined && cursor !== null) {
      // The kernel trace is not cursor-addressable; everything was delivered.
      return { chunks: [] };
    }
    const trace = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "readRemoteprocTrace", instance: row.name }),
      { failure: failWith("rproc.instance-missing"), phase: "lifecycle", step: "remoteproc trace" }
    );
    if (trace === "") {
      return { chunks: [] };
    }
    return { chunks: [{ bytes: Array.from(Buffer.from(trace)), stream: "stdout" }] };
  }

  async restorePrevious(configuration: unknown, signal?: AbortSignal): Promise<void> {
    const release = this.mutation.enter();
    try {
      const config = parseRemoteprocConfiguration(configuration);
      const row = await this.resolveInstance(config.instance, "probe", signal);
      this.retainIdentity(row);
      const privileged = await this.privilegeFor(row, signal);
      const retained = `${config.firmwarePath}.betelgeuz-prev-1`;
      const info = await this.transport.metadata(retained);
      if (info === null || !info.isFile) {
        throw new BetelgeuzError("artifact.missing", {
          detail: "no previous firmware version is retained",
        });
      }
      // The kernel refuses a firmware selection while the core runs
      // (`Device or resource busy`), so a restore stops first — the same
      // stop → select → start order a deploy uses. `stopAndWait` returning
      // means the core is stopped, so the start below is not redundant.
      const current = await this.resolveInstance(config.instance, "probe", signal);
      this.retainIdentity(current);
      if (mapState(current.state) !== "stopped") {
        await this.stopAndWait(current.name, privileged, signal);
      }
      await this.writeFirmware(
        row.name,
        firmwareName(retained),
        privileged,
        {
          failure: "deploy.commit-failed",
          missingFailure: "rproc.instance-missing",
          step: "previous firmware selection",
        },
        signal
      );
      await this.startAndWait(row.name, privileged, signal, "offline");
    } finally {
      release();
    }
  }

  /** The small core runs independently of the SSH session, so an explicit
   *  disconnect stops nothing on the target (plan §6). */
  async release(): Promise<void> {}

  reset(): void {
    if (this.mutation.held) {
      throw new BetelgeuzError("deploy.busy", {
        detail: "another mutating operation is already running",
      });
    }
    this.resetState();
  }

  /** The session is already gone, so no operation can still finish: the lock
   *  and every cached identity are dropped without their owners. A pending
   *  run completion stays unsettled — the core still runs and the next
   *  `inspect` is the only honest source of its state. */
  resetForcibly(): void {
    this.mutation.clear();
    this.resetState();
  }

  private resetState(): void {
    this.resolvedName = undefined;
    this.privileged = false;
    this.pending = undefined;
  }

  private run(): StrategyRun {
    let settle!: (outcome: RunOutcome) => void;
    const completion = new Promise<RunOutcome>((resolve) => {
      settle = resolve;
    });
    this.pending = { settle };
    return { completion, runId: `rproc-run-${randomUUID()}` };
  }

  /** Compares a freshly resolved instance against the bound one so a changed
   *  configuration or a re-pointed index can never silently re-target. */
  private retainIdentity(row: InstanceRow): void {
    if (this.resolvedName !== undefined && this.resolvedName !== row.name) {
      throw new BetelgeuzError("identity.instance-changed", {
        detail:
          `the configured instance resolved to \`${row.name}\`; ` +
          `this attach is bound to \`${this.resolvedName}\``,
      });
    }
    this.resolvedName = row.name;
  }

  private async resolveInstance(
    configured: string,
    mode: "probe" | "assert",
    signal?: AbortSignal
  ): Promise<InstanceRow> {
    const output = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "readRemoteprocInstances" }),
      {
        failure: failWith("rproc.instance-missing"),
        phase: "lifecycle",
        signal,
        step: "remoteproc instance table",
      }
    );
    const rows = parseInstanceTable(output);
    const byIndex = /^remoteproc[0-9]+$/.test(configured);
    const matches = byIndex
      ? rows.filter((row) => basename(row.directory) === configured)
      : rows.filter((row) => row.name === configured);
    if (matches.length === 1) {
      return matches[0];
    }
    const detail = matches.length === 0
      ? `no remoteproc instance matches \`${configured}\``
      : `\`${configured}\` matches ${matches.length} instances: ${matches
          .map((row) => row.name)
          .join(", ")}`;
    if (mode === "assert") {
      throw new BetelgeuzError("identity.instance-changed", { detail });
    }
    throw rprocError("rproc.instance-missing", { detail });
  }

  /**
   * Settles how control writes are issued: directly when this account may
   * write the instance's controls, otherwise through the passwordless sudo
   * whitelist — and a clear `privilege.denied` when it may do neither, since
   * a target that cannot be written cannot be operated (plan §10).
   *
   * The fallback asks whether the account may run the whitelisted control
   * write itself, so a probe never needs a command the whitelist does not
   * grant: `sudo -n -l` answers without writing anything.
   */
  private async privilegeFor(row: InstanceRow, signal?: AbortSignal): Promise<boolean> {
    if (row.writable === "yes") {
      this.privileged = false;
      return false;
    }
    if (this.privileged) {
      return true;
    }
    await runFixedCommand(
      this.transport,
      ExecRequest.fixed({
        kind: "probePasswordlessSudo",
        attribute: `${row.directory}/state`,
      }),
      {
        failure: () =>
          new BetelgeuzError("privilege.denied", {
            detail:
              "the account can neither write the remoteproc controls directly nor through " +
              "passwordless sudo; see docs/dev/remoteproc-setup.md",
          }),
        phase: "lifecycle",
        signal,
        step: "passwordless sudo probe",
      }
    );
    this.privileged = true;
    return true;
  }

  private async readPreflight(
    directory: string,
    signal?: AbortSignal
  ): Promise<{ freeBytes?: number; writable?: boolean }> {
    const output = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "preflightDestination", directory }),
      { failure: failWith("deploy.preflight-failed"), signal, step: "destination preflight" }
    );
    const fields = parseFields(output);
    const freeBytes = fields.freeBytes === undefined ? undefined : Number(fields.freeBytes);
    return {
      freeBytes:
        freeBytes !== undefined && Number.isSafeInteger(freeBytes) ? freeBytes : undefined,
      writable:
        fields.writable === "yes" ? true : fields.writable === "no" ? false : undefined,
    };
  }

  /**
   * Rotates the bounded retained set and returns the retained size: slot N is
   * freed, each lower slot moves up, and the current firmware becomes slot 1 —
   * before the commit, so a failure here activates nothing. The byte budget
   * then trims from the oldest slot (plan §4).
   */
  private async retainPrevious(
    firmwarePath: string,
    signal?: AbortSignal
  ): Promise<number | undefined> {
    // A rotation that starts must finish: it moves the retained files into a
    // consistent set before the commit renames the staged image over the
    // firmware path.
    throwIfAborted(signal, "deploy");
    const current = await this.transport.metadata(firmwarePath);
    if (current === null || !current.isFile) {
      return undefined;
    }
    const slotAt = (slot: number): string => `${firmwarePath}.betelgeuz-prev-${slot}`;
    await this.transport.remove(slotAt(MAX_RETAINED_FIRMWARE)).catch(() => undefined);
    for (let slot = MAX_RETAINED_FIRMWARE - 1; slot >= 1; slot -= 1) {
      const occupant = await this.transport.metadata(slotAt(slot));
      if (occupant === null) {
        continue;
      }
      await this.transport.rename(slotAt(slot), slotAt(slot + 1));
    }
    await this.transport.rename(firmwarePath, slotAt(1));
    await this.trimRetained(firmwarePath);
    return current.size;
  }

  private async trimRetained(firmwarePath: string): Promise<void> {
    const sizes: Array<number> = [];
    let total = 0;
    for (let slot = 1; slot <= MAX_RETAINED_FIRMWARE; slot += 1) {
      const info = await this.transport.metadata(`${firmwarePath}.betelgeuz-prev-${slot}`);
      const size = info?.isFile === true ? info.size : 0;
      sizes.push(size);
      total += size;
    }
    for (let slot = MAX_RETAINED_FIRMWARE; slot >= 1 && total > MAX_RETAINED_BYTES; slot -= 1) {
      const size = sizes[slot - 1];
      if (size === 0) {
        continue;
      }
      await this.transport.remove(`${firmwarePath}.betelgeuz-prev-${slot}`).catch(() => undefined);
      total -= size;
    }
  }

  private async writeState(
    name: string,
    value: "start" | "stop",
    privileged: boolean,
    write: ControlWrite,
    signal?: AbortSignal
  ): Promise<void> {
    const output = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "writeRemoteprocState", instance: name, value, privileged }),
      { failure: failWith(write.failure), phase: "lifecycle", signal, step: write.step }
    );
    this.assertInstancePresent(output, write);
  }

  private async writeFirmware(
    name: string,
    firmware: string,
    privileged: boolean,
    write: ControlWrite,
    signal?: AbortSignal
  ): Promise<void> {
    const output = await runFixedCommand(
      this.transport,
      ExecRequest.fixed({ kind: "writeRemoteprocFirmware", instance: name, firmware, privileged }),
      { failure: failWith(write.failure), phase: "lifecycle", signal, step: write.step }
    );
    this.assertInstancePresent(output, write);
  }

  private assertInstancePresent(output: string, write: ControlWrite): void {
    if (output.trim() === INSTANCE_MISSING_MARKER) {
      throw new BetelgeuzError(write.missingFailure, {
        detail: `the configured instance disappeared before the ${write.step}`,
      });
    }
  }

  private async stopAndWait(
    name: string,
    privileged: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    await this.writeState(
      name,
      "stop",
      privileged,
      { failure: "rproc.stop-failed", missingFailure: "rproc.stop-failed", step: "remoteproc stop" },
      signal
    );
    const observed = await this.pollState(
      name,
      (state) => mapState(state) === "stopped",
      signal
    );
    if (observed.matched) {
      return;
    }
    if (mapState(observed.last) === "crashed") {
      throw await this.crashFailure(observed.last, signal);
    }
    throw rprocError("rproc.stop-failed", {
      detail: `the core did not reach a stopped state within ${STATE_WAIT_TIMEOUT_MS} ms`,
      targetState: observed.last,
    });
  }

  private async startAndWait(
    name: string,
    privileged: boolean,
    signal?: AbortSignal,
    current?: string
  ): Promise<void> {
    if (current !== undefined && mapState(current) === "running") {
      // The requested state already holds, and the kernel refuses a redundant
      // start write on a running core.
      return;
    }
    await this.writeState(
      name,
      "start",
      privileged,
      { failure: "rproc.state-timeout", missingFailure: "rproc.instance-missing", step: "remoteproc start" },
      signal
    );
    const observed = await this.pollState(
      name,
      (state) => mapState(state) === "running",
      signal
    );
    if (observed.matched) {
      return;
    }
    if (mapState(observed.last) === "crashed") {
      throw await this.crashFailure(observed.last, signal);
    }
    throw rprocError("rproc.state-timeout", {
      detail: `the core did not reach a running state within ${STATE_WAIT_TIMEOUT_MS} ms`,
      targetState: observed.last,
    });
  }

  /**
   * Polls the instance's state until the predicate holds. A `crashed` state
   * ends the wait early without matching, because it is a distinct outcome
   * the caller reports — and the last observed state is carried out so a
   * timeout never guesses.
   */
  private async pollState(
    name: string,
    accept: (state: string) => boolean,
    signal?: AbortSignal
  ): Promise<{ last: string; matched: boolean }> {
    const deadline = Date.now() + STATE_WAIT_TIMEOUT_MS;
    let last = "";
    for (;;) {
      const row = await this.resolveInstance(name, "probe", signal);
      last = row.state;
      if (accept(last)) {
        return { last, matched: true };
      }
      if (mapState(last) === "crashed") {
        return { last, matched: false };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { last, matched: false };
      }
      await delay(Math.min(STATE_POLL_MS, remaining), signal);
    }
  }

  /**
   * The crash failure, carrying the kernel log tail where the account can
   * read it. A tail that cannot be read must never mask the crash itself.
   */
  private async crashFailure(state: string, signal?: AbortSignal): Promise<BetelgeuzError> {
    let tail: string | undefined;
    try {
      tail = await runFixedCommand(
        this.transport,
        ExecRequest.fixed({ kind: "readKernelLogTail" }),
        { failure: failWith("rproc.crashed"), phase: "lifecycle", signal, step: "kernel log tail" }
      );
    } catch {
      tail = undefined;
    }
    return rprocError("rproc.crashed", {
      detail: "the small core entered the crashed state",
      targetState: state,
      ...(tail === undefined || tail === "" ? {} : { cause: tail }),
    });
  }

  private async removeStaging(path: string): Promise<void> {
    try {
      await this.transport.remove(path);
    } catch {
      // Cleanup is best effort; the original deployment error is more useful.
    }
  }
}

/** Parses the instance table into rows; a malformed line is skipped rather
 *  than failing the probe, because the target's sysfs may hold entries this
 *  strategy does not understand. */
function parseInstanceTable(output: string): Array<InstanceRow> {
  const rows: Array<InstanceRow> = [];
  for (const line of output.split(/\r?\n/)) {
    if (line === "") {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== 5) {
      continue;
    }
    const [directory, name, state, firmware, writable] = fields;
    if (directory === "" || name === "") {
      continue;
    }
    rows.push({ directory, firmware, name, state, writable });
  }
  return rows;
}

/** Parses this strategy's configuration from the untrusted settings record.
 *  The instance is a sysfs name (or `remoteprocN` index) and the firmware
 *  path is absolute; anything else is a settings error, not a target one. */
export function parseRemoteprocConfiguration(
  value: unknown
): LinuxRemoteprocConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfiguration("the strategy configuration must be an object");
  }
  const record = value as Record<string, unknown>;
  const instance = record.instance;
  if (typeof instance !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(instance)) {
    throw invalidConfiguration(
      "instance must be a remoteproc sysfs name or a remoteprocN index"
    );
  }
  const firmwarePath = record.firmwarePath;
  if (
    typeof firmwarePath !== "string" ||
    firmwarePath.trim() === "" ||
    !firmwarePath.startsWith("/") ||
    firmwarePath.includes("\0")
  ) {
    throw invalidConfiguration("firmwarePath must be a non-empty absolute path");
  }
  return { firmwarePath, instance };
}

/**
 * Builds the failure a fixed command reports. A control write's failure may
 * be this strategy's own code or a shared one, so the factory resolves which
 * owner constructs it — the strategy-owned one carries its definition.
 */
function failWith(code: ErrorCode): (detail: string) => BetelgeuzError {
  return (detail) =>
    isRemoteprocCode(code)
      ? rprocError(code, { detail })
      : new BetelgeuzError(code, { detail });
}

function isRemoteprocCode(code: ErrorCode): code is RemoteprocErrorCode {
  return Object.prototype.hasOwnProperty.call(RPROC_ERRORS, code);
}

function mapState(raw: string): RemoteCoreState {
  switch (raw.trim()) {
    case "offline":
      return "stopped";
    case "running":
      return "running";
    case "crashed":
      return "crashed";
    case "suspended":
      return "suspended";
    default:
      return "unknown";
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The value written to the `firmware` attribute. The kernel contract is a
 * firmware NAME the loader resolves through its search paths — not a path:
 * a Tier 1 board rejects a slashed value outright, so the staged file's name
 * is selected and the file must therefore live where the loader searches
 * (see docs/dev/remoteproc-setup.md).
 */
function firmwareName(firmwarePath: string): string {
  return basename(firmwarePath);
}

function describeFirmwarePreflight(
  preflight: { freeBytes?: number; writable?: boolean },
  size: number
): string {
  if (preflight.writable !== true) {
    return "the firmware directory is not writable";
  }
  if (preflight.freeBytes !== undefined && preflight.freeBytes < size) {
    return "the firmware filesystem does not have enough free space";
  }
  return "the firmware destination failed deployment preflight";
}

function invalidConfiguration(detail: string): BetelgeuzError {
  return new BetelgeuzError("config.invalid", { detail });
}
