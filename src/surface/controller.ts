/** VS Code surface: turns commands into core calls and renders state/errors. */
import * as vscode from "vscode";

import { BetelgeuzError, isBetelgeuzError, type Phase } from "../errors";
import type {
  AttachResult,
  ConnectionState,
  CredentialMaterial,
  LogsParams,
  RunOutcome,
  StatusResult,
} from "../protocol";
import { ATTACH_STRATEGY_KEY, TARGET_PROFILE_KEY } from "../protocol";
import type { SessionLoss } from "../transport";
import { CoreService } from "../service";
import type { StrategyRun } from "../strategy";
import {
  STRATEGY_REGISTRY,
  STRATEGY_ROLES,
  strategyDescriptor,
  type StrategyDescriptor,
} from "../strategy";
import { SshClient } from "../transport/ssh";
import { clearCredential, loadCredential } from "./credentials";
import { phaseLabel, remediationFor } from "./remediation";
import { runReconnect } from "../reconnect";
import {
  persistAttach,
  persistedAttachFrom,
  readPersistedAttach,
  type PersistedAttach,
} from "./attach-store";
import {
  credentialFor,
  folderConfiguration,
  readProfileCatalog,
  readStrategyConfiguration,
  resolveArtifact,
  readTarget,
  saveHostKey,
} from "./settings";

interface WorkspaceRuntime {
  readonly core: CoreService<SshClient>;
  readonly transport: SshClient;
  state: ConnectionState;
  attach?: AttachResult;
  lastVerified?: PersistedAttach;
  lastError?: BetelgeuzError;
  run?: StrategyRun;
  /** Bumped on every user-driven transition (T3): async work carries the
   *  epoch it was issued in, and writes from a stale epoch are dropped. */
  epoch: number;
  /** Aborts the automatic reconnect loop — an explicit Disconnect or a new
   *  user action stops all retries. */
  reconnectAbort?: AbortController;
}

interface ProfilePick extends vscode.QuickPickItem {
  name: string;
}

interface StrategyPick extends vscode.QuickPickItem {
  /** Absent on the role separator items, which cannot be picked. */
  id?: string;
}

/** Upper bound on pages fetched by one `Logs` command: a target that is still
 * writing keeps adding output, so paging has to stop somewhere. */
const MAX_LOG_PAGES = 32;

/** One runtime per workspace folder; credentials stay in SecretStorage. */
export class ExtensionController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("Betelgeuz");
  private readonly status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  private readonly disposables: vscode.Disposable[] = [this.output, this.status];
  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  private activeFolderKey?: string;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri && vscode.workspace.getWorkspaceFolder(activeUri);
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.activeFolderKey = activeFolder?.uri.toString() ??
      (folders.length === 1 ? folders[0].uri.toString() : undefined);
    this.register("betelgeuz.selectSshTarget", "profile", () => this.selectSshTarget());
    this.register("betelgeuz.connect", "connect", () => this.connectSelected());
    this.register("betelgeuz.disconnect", "connect", () => this.disconnectSelected());
    this.register("betelgeuz.inspectAttach", "inspect", () => this.inspectSelected());
    this.register("betelgeuz.deploy", "deploy", () => this.deploySelected());
    this.register("betelgeuz.start", "lifecycle", () => this.startSelected());
    this.register("betelgeuz.stop", "lifecycle", () => this.stopSelected());
    this.register("betelgeuz.restart", "lifecycle", () => this.restartSelected());
    this.register("betelgeuz.status", "inspect", () => this.statusSelected());
    this.register("betelgeuz.logs", "inspect", () => this.logsSelected());
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (folder !== undefined) {
          this.activeFolderKey = folder.uri.toString();
        }
        this.refreshStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("betelgeuz")) {
          this.refreshStatus();
        }
      })
    );
    this.refreshStatus();
    this.log("Extension surface registered");
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const runtime of this.runtimes.values()) {
      // Shutdown stops retries like an explicit Disconnect does.
      runtime.epoch += 1;
      runtime.reconnectAbort?.abort("shutting down");
      runtime.reconnectAbort = undefined;
      const attach = runtime.attach;
      const closing = attach === undefined
        ? runtime.transport.close()
        : runtime.core.disconnect({ attachId: attach.attachId });
      void closing.catch((error: unknown) => this.logFailure(error, "connect"));
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private register(id: string, phase: Phase, handler: () => Promise<void>): void {
    this.disposables.push(
      vscode.commands.registerCommand(id, () => this.execute(phase, handler))
    );
  }

  private async execute(phase: Phase, handler: () => Promise<void>): Promise<void> {
    try {
      await handler();
    } catch (error) {
      await this.showFailure(error, phase, handler);
    }
  }

  private async selectSshTarget(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const catalog = readProfileCatalog();
    const choices: Array<ProfilePick> = Object.entries(catalog).map(
      ([name, profile]) => ({
        label: name,
        description: `${profile.username}@${profile.host}`,
        name,
      })
    );
    if (choices.length === 0) {
      const action = await vscode.window.showWarningMessage(
        "No Betelgeuz SSH profiles are configured.",
        "Open Settings"
      );
      if (action === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "betelgeuz.profiles"
        );
      }
      return;
    }
    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: "Select a Betelgeuz SSH target",
      matchOnDescription: true,
    });
    if (selected === undefined) {
      return;
    }
    this.activeFolderKey = folder.uri.toString();
    await folderConfiguration(folder).update(
      TARGET_PROFILE_KEY,
      selected.name,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    const strategy = await this.chooseStrategy();
    if (strategy?.id === undefined) {
      return;
    }
    await folderConfiguration(folder).update(
      ATTACH_STRATEGY_KEY,
      strategy.id,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    await this.connect(folder);
  }

  /** The strategy picker is generated from the compile-time registry and
   *  grouped by role (plan §7): the workspace chooses among the strategies
   *  this Betelgeuz version implements, never a hardcoded list. */
  private async chooseStrategy(): Promise<StrategyPick | undefined> {
    const items: Array<vscode.QuickPickItem> = [];
    for (const { label, role } of STRATEGY_ROLES) {
      const entries = STRATEGY_REGISTRY.filter(
        (entry) => entry.descriptor.role === role
      ).map((entry) => ({
        description: entry.descriptor.id,
        detail: entry.descriptor.detail,
        id: entry.descriptor.id,
        label: entry.descriptor.label,
      }));
      if (entries.length === 0) {
        continue;
      }
      items.push({ label, kind: vscode.QuickPickItemKind.Separator }, ...entries);
    }
    const selected = await vscode.window.showQuickPick<StrategyPick>(items, {
      placeHolder: "Select the deployment strategy for this workspace",
      matchOnDescription: true,
    });
    return selected;
  }

  private async connectSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder !== undefined) {
      await this.connect(folder);
    }
  }

  private async connect(folder: vscode.WorkspaceFolder): Promise<void> {
    const runtime = this.runtime(folder);
    if (runtime.state === "attached") {
      await vscode.window.showInformationMessage("Betelgeuz is already connected.");
      return;
    }
    // A user-initiated connect supersedes any reconnect in flight.
    runtime.epoch += 1;
    runtime.reconnectAbort?.abort("user cancelled");
    runtime.reconnectAbort = undefined;
    const epoch = runtime.epoch;
    this.activeFolderKey = folder.uri.toString();
    runtime.state = "connecting";
    runtime.lastError = undefined;
    this.refreshStatus();
    let connected = false;
    let material: CredentialMaterial | undefined;
    try {
      const catalog = readProfileCatalog();
      let target = readTarget(folder);
      const resolved = runtime.core.resolveProfile({ catalog, target }).profile;
      if (resolved.proxyHops > 0) {
        throw new BetelgeuzError("profile.unsupported-proxy", {
          detail: "proxy chains are not supported by the current SSH transport",
        });
      }

      if (!resolved.hostKeyPinned) {
        const observed = await this.withCancellableProgress(
          "Checking SSH host key",
          (signal) =>
            runtime.core.inspectHostKey({ catalog, target }, signal).then(
              (result) => result.hostKeyFingerprint
            )
        );
        const trust = await vscode.window.showWarningMessage(
          `Trust the SSH host key for ${resolved.username}@${resolved.host}:${resolved.port}?`,
          {
            modal: true,
            detail: `${observed}\nThis fingerprint will be saved to the Betelgeuz target profile.`,
          },
          "Trust Host"
        );
        if (trust !== "Trust Host") {
          return;
        }
        await saveHostKey(folder, catalog, target, observed);
        target = { ...target, hostKey: observed };
      }

      const credentialRef = credentialFor(catalog, target);
      material = await loadCredential(this.context.secrets, credentialRef);
      if (material === undefined) {
        return;
      }
      const { configuration, strategyId } = readStrategyConfiguration(folder);
      const credentialSecrets = { [credentialRef]: material };
      try {
        const attach = await this.withCancellableProgress(
          `Connecting to ${resolved.host}`,
          (signal) =>
            runtime.core.attach(
              {
                catalog,
                target,
                credentialSecrets,
                strategyConfiguration: configuration,
                strategyId,
              },
              signal
            )
        );
        if (runtime.epoch !== epoch) {
          // A newer user action (Disconnect, a second Connect) owns the state
          // now; this result is stale and its writes are dropped (T3). The
          // attach it created is released so the next Connect can bind.
          await runtime.core
            .disconnect({ attachId: attach.attachId })
            .catch((stale: unknown) => this.logFailure(stale, "connect"));
          return;
        }
        runtime.attach = attach;
        runtime.lastVerified = persistedAttachFrom(attach);
        runtime.state = "attached";
        connected = true;
        try {
          await persistAttach(
            this.context.workspaceState,
            folder.uri.toString(),
            runtime.lastVerified
          );
        } catch (error) {
          this.log(`Could not persist verified attach: ${errorText(error)}`);
        }
        this.log(
          `Attached ${attach.profile.username}@${attach.profile.host}:${attach.profile.port} using ${attach.strategyId}; host key ${attach.identity.hostKeyFingerprint}`
        );
        await vscode.window.showInformationMessage(
          `Betelgeuz connected to ${attach.profile.host}.`
        );
        await this.validateStrategy(folder, runtime, epoch);
      } finally {
        delete credentialSecrets[credentialRef];
      }
    } catch (error) {
      const structured = isBetelgeuzError(error)
        ? error
        : BetelgeuzError.wrapUnexpected("connect", error);
      if (structured.code !== "operation.cancelled") {
        runtime.lastError = structured;
      }
      throw error;
    } finally {
      if (material !== undefined) {
        clearCredential(material);
      }
      if (!connected && runtime.epoch === epoch) {
        runtime.state = "disconnected";
      }
      if (runtime.epoch === epoch) {
        this.refreshStatus();
      }
    }
  }

  /**
   * Probes the bound strategy's target interface after the attach bound
   * (Phase 5). An incompatibility is reported with the remedy the catalog
   * names, but the attach survives it: the binding holds and the user can
   * pick another strategy instead of re-running the identity handshake.
   */
  private async validateStrategy(
    folder: vscode.WorkspaceFolder,
    runtime: WorkspaceRuntime,
    epoch: number
  ): Promise<void> {
    const attach = runtime.attach;
    if (attach === undefined) {
      return;
    }
    try {
      const { configuration, strategyId } = readStrategyConfiguration(folder);
      await runtime.core.validateStrategy({ attachId: attach.attachId, configuration });
      this.log(`Strategy ${strategyId} validated against the target`);
    } catch (error) {
      if (runtime.epoch !== epoch) {
        return;
      }
      const structured = isBetelgeuzError(error)
        ? error
        : BetelgeuzError.wrapUnexpected("inspect", error);
      runtime.lastError = structured;
      this.refreshStatus();
      await this.showFailure(structured, "inspect", () =>
        this.validateStrategy(folder, runtime, runtime.epoch)
      );
    }
  }

  private async disconnectSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.runtime(folder);
    // An explicit Disconnect stops all retries and owns the state from here.
    runtime.epoch += 1;
    runtime.reconnectAbort?.abort("user cancelled");
    runtime.reconnectAbort = undefined;
    if (runtime.attach === undefined) {
      runtime.state = "disconnected";
      this.refreshStatus();
      return;
    }
    const attach = runtime.attach;
    await runtime.core.disconnect({ attachId: attach.attachId });
    runtime.attach = undefined;
    runtime.run = undefined;
    runtime.state = "disconnected";
    runtime.lastError = undefined;
    this.log(`Disconnected ${attach.profile.host}:${attach.profile.port}`);
    this.refreshStatus();
  }

  private async inspectSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.runtime(folder);
    this.refreshStatus();
    const verified = runtime.attach === undefined ? runtime.lastVerified :
      persistedAttachFrom(runtime.attach);
    if (verified === undefined) {
      await vscode.window.showInformationMessage(
        "No target identity has been verified for this workspace."
      );
      return;
    }
    const state = runtime.state === "attached" ? "Connected" : "Offline";
    const model = verified.identity.descriptor.model ?? "unknown board";
    this.log(
      `Inspect attach: ${state}; ${verified.profile.host}:${verified.profile.port}; ${verified.strategyId}; ${model}; verified ${verified.verifiedAt}`
    );
    await vscode.window.showInformationMessage(
      `${state}: ${verified.profile.host}:${verified.profile.port} - ${verified.strategyId} - ${model}`
    );
  }

  private async deploySelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const attachId = runtime.attach?.attachId as string;
    const { configuration, strategyId } = readStrategyConfiguration(folder);
    const descriptor = strategyDescriptor(strategyId);
    // A strategy whose deploy stops a running target needs the plan's explicit
    // confirmation (§6: stopping target work always requires user action), so
    // the current state is asked for and a decline cancels the deploy.
    const stopRunningTarget = descriptor?.stopsTargetToDeploy === true
      ? await this.confirmStopToDeploy(runtime, attachId, configuration, descriptor)
      : false;
    if (stopRunningTarget === "declined") {
      return;
    }
    const artifact = await resolveArtifact(folder, this.context.workspaceState);
    const result = await this.withCancellableProgress(
      `Deploying ${artifact.targetName}`,
      (signal) => runtime.core.deploy(
        {
          attachId,
          artifact,
          configuration,
          ...(stopRunningTarget === true ? { stopRunningTarget: true } : {}),
        },
        signal
      )
    );
    this.log(`Deployed ${artifact.path} to ${result.remotePath}`);
    await vscode.window.showInformationMessage(
      `Betelgeuz deployed ${result.remotePath} with ${descriptor?.label ?? strategyId}.`
    );
  }

  /** Asks whether a running target may be stopped to deploy. Returns
   *  `false` when the target is already stopped and `"declined"` when the
   *  user cancels — the caller must not deploy in that case. */
  private async confirmStopToDeploy(
    runtime: WorkspaceRuntime,
    attachId: string,
    configuration: unknown,
    descriptor: StrategyDescriptor
  ): Promise<boolean | "declined"> {
    const status = await runtime.core.status({ attachId, configuration });
    if (status.state === "stopped") {
      return false;
    }
    const answer = await vscode.window.showWarningMessage(
      `The ${descriptor.label} target is ${status.state} and will be stopped to deploy.`,
      { modal: true },
      "Stop and Deploy"
    );
    return answer === "Stop and Deploy" ? true : "declined";
  }

  private async startSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const { configuration, strategyId } = readStrategyConfiguration(folder);
    const run = await this.withCancellableProgress(
      `Starting ${strategyDescriptor(strategyId)?.label ?? "target"}`,
      (signal) => runtime.core.start(
        {
          attachId: runtime.attach?.attachId as string,
          configuration,
        },
        (chunk) => this.logOutput(chunk.stream, chunk.bytes),
        signal
      )
    );
    runtime.run = run;
    this.log(`Started ${strategyDescriptor(strategyId)?.label ?? "target"} (${run.runId})`);
    this.trackRun(runtime, run);
  }

  private async stopSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const { configuration, strategyId } = readStrategyConfiguration(folder);
    const outcome = await runtime.core.stop({
      attachId: runtime.attach?.attachId as string,
      configuration,
      graceMs: 5_000,
    });
    runtime.run = undefined;
    const label = strategyDescriptor(strategyId)?.label ?? "target";
    this.log(`Stopped ${label}${outcome?.signal === undefined ? "" : ` by ${outcome.signal}`}`);
    this.refreshStatus();
  }

  private async restartSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const { configuration, strategyId } = readStrategyConfiguration(folder);
    const run = await runtime.core.restart(
      {
        attachId: runtime.attach?.attachId as string,
        configuration,
      },
      (chunk) => this.logOutput(chunk.stream, chunk.bytes)
    );
    runtime.run = run;
    this.log(`Restarted ${strategyDescriptor(strategyId)?.label ?? "target"} (${run.runId})`);
    this.trackRun(runtime, run);
  }

  /** Watches a run to its end: an unobserved `completion` would surface a run
   * failure as an unhandled rejection and leave stale state in the runtime. */
  private trackRun(runtime: WorkspaceRuntime, run: StrategyRun): void {
    void run.completion.then((outcome) => {
      if (runtime.run === run) {
        runtime.run = undefined;
      }
      // An outcome without fields is a strategy that reports no process
      // outcome — the small core has none — so nothing is claimed for it.
      this.log(
        `Target run finished${outcome.status === undefined ? "" : ` with status ${outcome.status}`}${outcome.signal === undefined ? "" : ` by ${outcome.signal}`}`
      );
      this.refreshStatus();
    }).catch((error: unknown) => {
      if (runtime.run === run) {
        runtime.run = undefined;
      }
      this.logFailure(error, "lifecycle");
      this.refreshStatus();
    });
  }

  private async statusSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const { configuration, strategyId } = readStrategyConfiguration(folder);
    const descriptor = strategyDescriptor(strategyId);
    const status: StatusResult = await runtime.core.status({
      attachId: runtime.attach?.attachId as string,
      configuration,
    });
    const label = descriptor?.label ?? "target";
    const detail = status.detail === undefined ? "" : ` (${status.detail})`;
    this.log(`Target status: ${status.state}${detail}`);
    await vscode.window.showInformationMessage(
      `Betelgeuz ${label}: ${status.state}.`
    );
  }

  private async logsSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const attachId = runtime.attach?.attachId as string;
    const { configuration } = readStrategyConfiguration(folder);
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
      const params: LogsParams = cursor === undefined || cursor === null
        ? { attachId, configuration }
        : { attachId, configuration, cursor };
      const result = await runtime.core.logs(params);
      for (const chunk of result.chunks) {
        this.logOutput(chunk.stream, Uint8Array.from(chunk.bytes));
      }
      if (result.nextCursor === undefined || result.nextCursor === null) {
        break;
      }
      cursor = result.nextCursor;
    }
    this.output.show(true);
  }

  private requireAttached(folder: vscode.WorkspaceFolder): WorkspaceRuntime {
    const runtime = this.runtime(folder);
    if (runtime.attach === undefined) {
      throw new BetelgeuzError("identity.instance-changed", {
        detail: "connect this workspace before using target operations",
      });
    }
    return runtime;
  }

  private logOutput(stream: "stdout" | "stderr", bytes: ArrayLike<number>): void {
    const text = Buffer.from(bytes).toString();
    for (const line of text.split(/\r?\n/)) {
      if (line !== "") {
        this.log(`[${stream}] ${line}`);
      }
    }
  }

  private async chooseWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      await vscode.window.showWarningMessage(
        "Open a workspace folder before connecting a target."
      );
      return undefined;
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const active = activeUri && vscode.workspace.getWorkspaceFolder(activeUri);
    if (active !== undefined) {
      this.activeFolderKey = active.uri.toString();
      this.refreshStatus();
      return active;
    }
    const remembered = folders.find(
      (folder) => folder.uri.toString() === this.activeFolderKey
    );
    if (remembered !== undefined) {
      this.refreshStatus();
      return remembered;
    }
    if (folders.length === 1) {
      this.activeFolderKey = folders[0].uri.toString();
      this.refreshStatus();
      return folders[0];
    }
    const choices = folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    }));
    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: "Select the workspace folder for this target",
      matchOnDescription: true,
    });
    if (selected === undefined) {
      return undefined;
    }
    this.activeFolderKey = selected.folder.uri.toString();
    this.refreshStatus();
    return selected.folder;
  }

  private runtime(folder: vscode.WorkspaceFolder): WorkspaceRuntime {
    const key = folder.uri.toString();
    const existing = this.runtimes.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const transport = new SshClient();
    const runtime: WorkspaceRuntime = {
      core: new CoreService(transport),
      transport,
      state: "disconnected",
      lastVerified: readPersistedAttach(this.context.workspaceState, key),
      epoch: 0,
    };
    this.runtimes.set(key, runtime);
    const unsubscribe = transport.onSessionLoss((loss) => {
      void this.handleSessionLoss(folder, runtime, loss).catch((error: unknown) =>
        this.logFailure(error, "connect")
      );
    });
    this.disposables.push(new vscode.Disposable(unsubscribe));
    return runtime;
  }

  private async handleSessionLoss(
    folder: vscode.WorkspaceFolder,
    runtime: WorkspaceRuntime,
    loss: SessionLoss
  ): Promise<void> {
    const attach = runtime.attach;
    runtime.lastError = new BetelgeuzError(loss.cause, { detail: loss.detail });
    this.log(`SSH session lost for ${folder.name}: ${loss.cause}`);
    if (attach === undefined) {
      runtime.state = "disconnected";
      this.refreshStatus();
      return;
    }
    // The connection is a state of the attach, not the attach itself (plan
    // §3): a drop triggers bounded automatic reconnect, not teardown.
    const epoch = runtime.epoch;
    runtime.state = "reconnecting";
    this.refreshStatus();
    const abort = new AbortController();
    runtime.reconnectAbort = abort;
    try {
      await runReconnect(
        async () => {
          const catalog = readProfileCatalog();
          const target = readTarget(folder);
          const credentialRef = credentialFor(catalog, target);
          const material = await loadCredential(this.context.secrets, credentialRef);
          if (material === undefined) {
            throw new BetelgeuzError("ssh.auth-failed", {
              detail: `no credential is stored for ${credentialRef}`,
            });
          }
          try {
            await runtime.core.reconnect(
              {
                attachId: attach.attachId,
                catalog,
                target,
                credentialSecrets: { [credentialRef]: material },
              },
              abort.signal
            );
          } finally {
            clearCredential(material);
          }
        },
        {
          signal: abort.signal,
          onRetry: (error, retry, delayMs) => {
            const code = isBetelgeuzError(error) ? error.code : "internal.unexpected";
            this.log(
              `Reconnect attempt ${retry} for ${folder.name} failed: ${code}; retrying in ${delayMs} ms`
            );
          },
        }
      );
      if (runtime.epoch !== epoch) {
        return; // a newer user action owns the state now
      }
      runtime.state = "attached";
      runtime.lastError = undefined;
      this.log(`Reconnected to ${folder.name}; restoring target state`);
      this.refreshStatus();
      await this.restoreTargetState(folder, runtime, epoch);
    } catch (error) {
      if (runtime.epoch !== epoch) {
        return;
      }
      const failure = isBetelgeuzError(error)
        ? error
        : BetelgeuzError.wrapUnexpected("connect", error);
      if (failure.code === "operation.cancelled") {
        // An explicit Disconnect or a new action stopped the retries; that
        // owner reports the state.
        return;
      }
      // The binding may already be gone (a revalidation failure invalidates
      // it inside `reconnect`); `abandonAttach` is idempotent either way.
      await runtime.core.abandonAttach();
      runtime.attach = undefined;
      runtime.run = undefined;
      runtime.state = "disconnected";
      runtime.lastError = failure;
      this.log(`Reconnect to ${folder.name} gave up: ${failure.code}`);
      this.refreshStatus();
      if (this.activeFolderKey === folder.uri.toString()) {
        await this.showFailure(failure, "connect", () => this.connect(folder));
      }
    } finally {
      if (runtime.reconnectAbort === abort) {
        runtime.reconnectAbort = undefined;
      }
    }
  }

  /** Re-queries the target after a reconnect and reports what became of the
   *  run while the channel was gone — through the bound strategy, whose
   *  `inspect` is the source of truth after a reconnect (plan §6). */
  private async restoreTargetState(
    folder: vscode.WorkspaceFolder,
    runtime: WorkspaceRuntime,
    epoch: number
  ): Promise<void> {
    const attach = runtime.attach;
    if (attach === undefined) {
      return;
    }
    try {
      const { configuration } = readStrategyConfiguration(folder);
      const status = await runtime.core.status({ attachId: attach.attachId, configuration });
      if (runtime.epoch !== epoch) {
        return;
      }
      const detail = status.outcome === undefined
        ? ""
        : ` (${describeOutcome(status.outcome)})`;
      this.log(`Target state after reconnect: ${status.state}${detail}`);
    } catch (error) {
      if (runtime.epoch !== epoch) {
        return;
      }
      this.logFailure(error, "lifecycle");
    }
    this.refreshStatus();
  }

  private async withCancellableProgress<T>(
    title: string,
    action: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() =>
          controller.abort("user cancelled")
        );
        try {
          return await action(controller.signal);
        } finally {
          cancellation.dispose();
        }
      }
    );
  }

  private refreshStatus(): void {
    const folder = (vscode.workspace.workspaceFolders ?? []).find(
      (candidate) => candidate.uri.toString() === this.activeFolderKey
    );
    const runtime = folder === undefined
      ? undefined
      : this.runtimes.get(this.activeFolderKey ?? "");
    const state = runtime?.state ?? "disconnected";
    this.status.text = `$(plug) Betelgeuz: ${statusLabel(state)}`;
    const persisted = runtime?.lastVerified ??
      (this.activeFolderKey === undefined
        ? undefined
        : readPersistedAttach(this.context.workspaceState, this.activeFolderKey));
    const profile = runtime?.attach?.profile ?? persisted?.profile;
    const strategy = runtime?.attach?.strategyId ?? persisted?.strategyId;
    const location = profile === undefined
      ? "No verified target for this workspace"
      : `${profile.username}@${profile.host}:${profile.port} - ${strategy ?? "unknown strategy"}`;
    this.status.tooltip = runtime?.lastError === undefined
      ? location
      : `${location}\n${runtime.lastError.summary}`;
    this.status.command = state === "attached"
      ? "betelgeuz.disconnect"
      : folder === undefined
        ? "betelgeuz.selectSshTarget"
        : "betelgeuz.connect";
    this.status.show();
  }

  private async showFailure(
    error: unknown,
    phase: Phase,
    retry?: () => Promise<void>
  ): Promise<void> {
    const structured = isBetelgeuzError(error)
      ? error
      : BetelgeuzError.wrapUnexpected(phase, error);
    this.logFailure(structured, structured.phase);
    if (structured.code === "operation.cancelled") {
      await vscode.window.showInformationMessage("Betelgeuz connection cancelled.");
      return;
    }
    const remediation = remediationFor(structured);
    // The plan's presentation model (§6): failures are labelled by phase and
    // carry one concrete remediation action. The summary is the catalog's
    // uniform wording; the detail names the offending value; the advice is the
    // step the plan's action table promises.
    const lines = [
      `Betelgeuz [${phaseLabel(structured.phase)}]: ${structured.summary}`,
    ];
    if (structured.detail !== undefined) {
      lines.push(structured.detail);
    }
    if (remediation.advice !== "") {
      lines.push(remediation.advice);
    }
    const items: Array<string> = [];
    if (remediation.retry === true && retry !== undefined) {
      items.push("Try Again");
    }
    const button = remediation.button;
    if (button !== undefined && this.commandAvailable(button)) {
      items.push(button.label);
    }
    items.push("View Log");
    const action = await vscode.window.showErrorMessage(lines.join("\n"), ...items);
    if (action === undefined) {
      return;
    }
    if (action === "View Log") {
      this.output.show(true);
      return;
    }
    if (action === "Try Again") {
      // The failed command's own handler: the retry is the same operation, not
      // a look-alike assembled here.
      await retry?.();
      return;
    }
    if (button !== undefined) {
      await vscode.commands.executeCommand(button.command, ...(button.args ?? []));
    }
  }

  /** A button whose command is not installed is worse than no button: it would
   *  fail on click. The one conditional command is CMake Tools' build. */
  private commandAvailable(button: { requiresExtension?: string }): boolean {
    return button.requiresExtension === undefined ||
      vscode.extensions.getExtension(button.requiresExtension) !== undefined;
  }

  private logFailure(error: unknown, phase: Phase): void {
    if (isBetelgeuzError(error)) {
      const context = [error.detail, error.causeText].filter(Boolean).join("\n");
      this.log(`[${phase}] ${error.code}: ${error.summary}${context ? `\n${context}` : ""}`);
      return;
    }
    this.log(`[${phase}] unexpected failure: ${errorText(error)}`);
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function statusLabel(state: ConnectionState): string {
  switch (state) {
    case "connecting":
      return "Connecting";
    case "attached":
      return "Attached";
    case "reconnecting":
      return "Reconnecting";
    case "disconnected":
      return "Disconnected";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/** Renders a run outcome for the log — including its own gaps: an outcome
 *  with neither status nor signal is an exit whose details were never
 *  observed, and the log says exactly that. */
function describeOutcome(outcome: RunOutcome): string {
  if (outcome.status !== undefined) {
    return `exit status ${outcome.status}`;
  }
  if (outcome.signal !== undefined) {
    return `terminating signal ${outcome.signal}`;
  }
  return "exit status not observed";
}
