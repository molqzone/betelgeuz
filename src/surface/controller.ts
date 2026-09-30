/** VS Code surface: turns commands into core calls and renders state/errors. */
import * as vscode from "vscode";

import { BetelgeuzError, errorDef, isBetelgeuzError, type Phase } from "../errors";
import type {
  AttachResult,
  ConnectionState,
  CredentialMaterial,
  LogsParams,
} from "../protocol";
import { ATTACH_STRATEGY_KEY, TARGET_PROFILE_KEY } from "../protocol";
import type { SessionLoss } from "../transport";
import { CoreService } from "../service";
import type { ApplicationRun } from "../strategies/ssh-app";
import { SshClient } from "../transport/ssh";
import { clearCredential, loadCredential } from "./credentials";
import {
  persistAttach,
  persistedAttachFrom,
  readPersistedAttach,
  type PersistedAttach,
} from "./attach-store";
import {
  credentialFor,
  folderConfiguration,
  readApplicationConfiguration,
  readArtifactRecord,
  readProfileCatalog,
  readStrategy,
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
  run?: ApplicationRun;
}

interface ProfilePick extends vscode.QuickPickItem {
  name: string;
}

interface StrategyPick extends vscode.QuickPickItem {
  id: string;
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
      await this.showFailure(error, phase);
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
    if (strategy === undefined) {
      return;
    }
    await folderConfiguration(folder).update(
      ATTACH_STRATEGY_KEY,
      strategy.id,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
    await this.connect(folder);
  }

  private async chooseStrategy(): Promise<StrategyPick | undefined> {
    return await vscode.window.showQuickPick<StrategyPick>(
      [
        {
          label: "Linux application",
          description: "linux.ssh-app",
          detail: "Deploy and run a Linux userspace application over SSH",
          id: "linux.ssh-app",
        },
      ],
      {
        placeHolder: "Select the deployment strategy for this workspace",
        matchOnDescription: true,
      }
    );
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
                strategyId: readStrategy(folder),
              },
              signal
            )
        );
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
      if (!connected) {
        runtime.state = "disconnected";
      }
      this.refreshStatus();
    }
  }

  private async disconnectSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.runtime(folder);
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
    const artifact = await readArtifactRecord(folder);
    const configuration = readApplicationConfiguration(folder);
    const result = await this.withCancellableProgress(
      `Deploying ${artifact.targetName}`,
      (signal) => runtime.core.deploy(
        { attachId: runtime.attach?.attachId as string, artifact, configuration },
        signal
      )
    );
    this.log(`Deployed ${artifact.path} to ${result.remotePath}`);
    await vscode.window.showInformationMessage(`Betelgeuz deployed ${result.remotePath}.`);
  }

  private async startSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const configuration = readApplicationConfiguration(folder);
    const run = await this.withCancellableProgress(
      "Starting target application",
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
    this.log(`Started target application (${run.runId})`);
    this.trackRun(runtime, run);
  }

  private async stopSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const outcome = await runtime.core.stop({
      attachId: runtime.attach?.attachId as string,
      graceMs: 5_000,
    });
    runtime.run = undefined;
    this.log(`Stopped target application${outcome?.signal === undefined ? "" : ` by ${outcome.signal}`}`);
    this.refreshStatus();
  }

  private async restartSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const configuration = readApplicationConfiguration(folder);
    const run = await runtime.core.restart(
      {
        attachId: runtime.attach?.attachId as string,
        configuration,
      },
      (chunk) => this.logOutput(chunk.stream, chunk.bytes)
    );
    runtime.run = run;
    this.log(`Restarted target application (${run.runId})`);
    this.trackRun(runtime, run);
  }

  /** Watches a run to its end: an unobserved `completion` would surface a run
   * failure as an unhandled rejection and leave stale state in the runtime. */
  private trackRun(runtime: WorkspaceRuntime, run: ApplicationRun): void {
    void run.completion.then((outcome) => {
      if (runtime.run === run) {
        runtime.run = undefined;
      }
      this.log(
        `Target application exited${outcome.status === undefined ? "" : ` with status ${outcome.status}`}${outcome.signal === undefined ? "" : ` by ${outcome.signal}`}`
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
    const status = runtime.core.status({ attachId: runtime.attach?.attachId as string });
    this.log(`Target application status: ${status.state}`);
    await vscode.window.showInformationMessage(
      `Betelgeuz target application: ${status.state}.`
    );
  }

  private async logsSelected(): Promise<void> {
    const folder = await this.chooseWorkspaceFolder();
    if (folder === undefined) {
      return;
    }
    const runtime = this.requireAttached(folder);
    const attachId = runtime.attach?.attachId as string;
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
      const params: LogsParams = cursor === undefined || cursor === null
        ? { attachId }
        : { attachId, cursor };
      const result = runtime.core.logs(params);
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
    runtime.attach = undefined;
    runtime.run = undefined;
    runtime.state = "disconnected";
    runtime.lastError = new BetelgeuzError(loss.cause, { detail: loss.detail });
    this.log(`SSH session lost for ${folder.name}: ${loss.cause}`);
    this.refreshStatus();
    if (attach !== undefined) {
      await runtime.core.abandonAttach();
    }
    if (this.activeFolderKey === folder.uri.toString()) {
      await this.showFailure(runtime.lastError, "connect");
    }
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
      : `${location}\n${errorDef(runtime.lastError.code).summary}`;
    this.status.command = state === "attached"
      ? "betelgeuz.disconnect"
      : folder === undefined
        ? "betelgeuz.selectSshTarget"
        : "betelgeuz.connect";
    this.status.show();
  }

  private async showFailure(error: unknown, phase: Phase): Promise<void> {
    const structured = isBetelgeuzError(error)
      ? error
      : BetelgeuzError.wrapUnexpected(phase, error);
    this.logFailure(structured, structured.phase);
    if (structured.code === "operation.cancelled") {
      await vscode.window.showInformationMessage("Betelgeuz connection cancelled.");
      return;
    }
    const action = await vscode.window.showErrorMessage(
      `Betelgeuz: ${errorDef(structured.code).summary}`,
      "Open Settings",
      "View Output"
    );
    if (action === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "betelgeuz");
    } else if (action === "View Output") {
      this.output.show(true);
    }
  }

  private logFailure(error: unknown, phase: Phase): void {
    if (isBetelgeuzError(error)) {
      const summary = errorDef(error.code).summary;
      const context = [error.detail, error.causeText].filter(Boolean).join("\n");
      this.log(`[${phase}] ${error.code}: ${summary}${context ? `\n${context}` : ""}`);
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
