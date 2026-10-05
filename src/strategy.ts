/**
 * The deploy strategy contract and the compile-time registry.
 *
 * A strategy is a workflow bundle: artifact placement, activation, lifecycle
 * verbs, inspection, and log source, coordinated by shared core services
 * (plan §6). The command layer routes every verb to the active attach's
 * strategy and never addresses a board or chip resource directly.
 *
 * Two implementations exist — `linux.ssh-app` and `linux.remoteproc` — so the
 * interface these lines declare has its second concrete user and may exist
 * (docs/dev abstraction policy, rule of two). The registry is compile-time:
 * adding a strategy means adding one module and its metadata here. Strategy
 * configuration and target validation stay inside each strategy; this module
 * only names the operations and carries the metadata the surface renders.
 */
import type { SshTransport } from "./transport";
import type {
  ArtifactRecord,
  LogsResult,
  OutputListener,
  RunOutcome,
  StatusResult,
  TargetOperation,
} from "./protocol";
import { SshApplicationStrategy } from "./strategies/ssh-app";
import { LinuxRemoteprocStrategy } from "./strategies/remoteproc";

/** UX grouping for the strategy picker (plan §7): big-core application and
 *  small-core firmware. A label, not an architectural layer. */
export type StrategyRole = "big-core" | "small-core";

/** What one deploy of a strategy produced. `remotePath` names where the
 *  artifact now lives on the target — the application path or the firmware
 *  location; `previousSize` is the retained previous version's size. */
export type DeployOutcome = {
  previousSize?: number;
  remotePath: string;
};

/** A started operation. `completion` settles when the strategy's target work
 *  ends — for the foreground application strategy, when the process exits;
 *  for the small-core strategy, when the core is stopped or the handle is
 *  discarded. The outcome is the strategy's report of how it ended. */
export type StrategyRun = {
  completion: Promise<RunOutcome>;
  runId: string;
};

export type DeployOptions = {
  signal?: AbortSignal;
  /** The user confirmed stopping a running target before this deploy (plan
   *  §6: stopping target work always requires explicit user action). */
  stopRunningTarget?: boolean;
};

/**
 * One deploy strategy, bound to the workspace's attach. Every operation is
 * cancellable through its signal where it can wait.
 *
 * Contract rules the implementations share:
 *
 * - `validate` checks the strategy's own configuration and probes the target
 *   interfaces its operations need; incompatibility is `strategy.
 *   unsupported-target`, and it never discards the attach.
 * - `assertIdentity` re-checks strategy-owned identity after a reconnect —
 *   the resolved remoteproc instance name for `linux.remoteproc`, nothing
 *   for a strategy with no such identity — and a change is
 *   `identity.instance-changed`, never a silent re-target.
 * - A mutating operation holds the busy lock for its duration; a second one
 *   fails with `deploy.busy` rather than queueing (plan §6).
 * - Every operation carries the strategy's configuration, parsed by the
 *   strategy itself, so an operation never depends on another having run
 *   first; a strategy that needs no configuration for an operation ignores
 *   it.
 * - Cancellation has a commit point. Before it the target is untouched and
 *   staging is removed (`deploy.cancelled`); after it the operation runs to
 *   completion or a definitive failure.
 */
export type DeployStrategy = {
  readonly id: string;
  readonly role: StrategyRole;
  validate(configuration: unknown, signal?: AbortSignal): Promise<void>;
  assertIdentity(signal?: AbortSignal): Promise<void>;
  deploy(
    artifact: ArtifactRecord,
    configuration: unknown,
    options?: DeployOptions
  ): Promise<DeployOutcome>;
  start(
    configuration: unknown,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<StrategyRun>;
  stop(configuration: unknown, graceMs?: number): Promise<RunOutcome | undefined>;
  restart(
    configuration: unknown,
    onOutput?: OutputListener,
    signal?: AbortSignal
  ): Promise<StrategyRun>;
  inspect(configuration: unknown, signal?: AbortSignal): Promise<StatusResult>;
  /** Async because a strategy may read its logs from the target rather than
   *  from a host-side buffer. */
  logs(
    configuration: unknown,
    cursor?: string | null,
    maxBytes?: number
  ): Promise<LogsResult>;
  restorePrevious(configuration: unknown, signal?: AbortSignal): Promise<void>;
  /** Stops the target work this strategy owns for an explicit disconnect.
   *  A strategy whose runtime outlives the session does nothing. */
  release(): Promise<void>;
  /** Clears per-attach state; refuses while a mutating operation runs. */
  reset(): void;
  /** Clears per-attach state after the owning session is already gone. */
  resetForcibly(): void;
};

/** What the surface renders and routes on; the strategy module owns the
 *  behavior behind it. */
export type StrategyDescriptor = {
  detail: string;
  id: string;
  label: string;
  operations: ReadonlyArray<TargetOperation>;
  role: StrategyRole;
  /** True when deploying stops a running target, so the surface asks for the
   *  explicit confirmation before Deploy runs. */
  stopsTargetToDeploy: boolean;
};

export type StrategyRegistration = {
  create: (transport: SshTransport) => DeployStrategy;
  descriptor: StrategyDescriptor;
};

/** The implemented strategies, in picker order. */
export const STRATEGY_REGISTRY: ReadonlyArray<StrategyRegistration> = [
  {
    create: (transport) => new SshApplicationStrategy(transport),
    descriptor: {
      detail: "Deploy and run a Linux userspace application over SSH",
      id: "linux.ssh-app",
      label: "Linux application",
      operations: ["deploy", "start", "stop", "restart", "logs"],
      role: "big-core",
      stopsTargetToDeploy: false,
    },
  },
  {
    create: (transport) => new LinuxRemoteprocStrategy(transport),
    descriptor: {
      detail: "Load and control a small-core firmware image through Linux remoteproc",
      id: "linux.remoteproc",
      label: "Linux small-core firmware",
      operations: ["deploy", "start", "stop", "restart", "restorePrevious", "logs"],
      role: "small-core",
      stopsTargetToDeploy: true,
    },
  },
];

/** The role groupings the strategy picker offers, in display order. */
export const STRATEGY_ROLES: ReadonlyArray<{ label: string; role: StrategyRole }> = [
  { label: "Big-core application", role: "big-core" },
  { label: "Small-core firmware", role: "small-core" },
];

/** The descriptor of an implemented strategy, or `undefined` when the
 *  installed version does not implement that ID. */
export function strategyDescriptor(id: string): StrategyDescriptor | undefined {
  return STRATEGY_REGISTRY.find((entry) => entry.descriptor.id === id)?.descriptor;
}
