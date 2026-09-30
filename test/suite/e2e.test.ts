/**
 * End-to-end coverage for the surface layer: the commands a user runs, through
 * the real extension host, against a real board.
 *
 * The extension host runs headless, so nothing answers its dialogs. The stubs
 * below stand in for the user — they choose the same items the QuickPicks offer
 * and type the password the environment holds — and every message the extension
 * shows is captured, so a command that reaches the user is observable.
 */
import assert from "node:assert/strict";

import * as vscode from "vscode";

import { Secret } from "../../src/secret";
import {
  readApplicationConfiguration,
  readProfileCatalog,
  readStrategy,
  readTarget,
} from "../../src/surface/settings";
import { ExecRequest, HostKeyFingerprint } from "../../src/transport/index";
import { SshClient } from "../../src/transport/ssh";

const HOST = process.env.BETELGEUZ_TEST_HOST ?? "";
const PORT = Number(process.env.BETELGEUZ_TEST_PORT ?? "22");
const USER = process.env.BETELGEUZ_TEST_USER ?? "root";
const PASSWORD = process.env.BETELGEUZ_TEST_PASSWORD ?? "";
const REMOTE_APP = "/tmp/betelgeuz-e2e/app";

const shown: Array<{ level: string; text: string }> = [];

/** Deterministic answers to whatever the surface asks. */
function stubDialogs(): void {
  const pick = async (items: unknown): Promise<unknown> => {
    const list = Array.isArray(items) ? items : [items];
    return list[0];
  };
  vscode.window.showQuickPick = pick as unknown as typeof vscode.window.showQuickPick;
  vscode.window.showInputBox = (async () => PASSWORD) as unknown as typeof vscode.window.showInputBox;
  vscode.window.showOpenDialog = (async () => []) as unknown as typeof vscode.window.showOpenDialog;
  vscode.window.showWarningMessage = (async (_message: unknown, ...rest: unknown[]) => {
    const items = rest.filter((item): item is string => typeof item === "string");
    return items[0] ?? undefined;
  }) as unknown as typeof vscode.window.showWarningMessage;
  const record =
    (level: string) =>
    async (message: unknown): Promise<undefined> => {
      shown.push({ level, text: String(message) });
      return undefined;
    };
  vscode.window.showInformationMessage = record("info") as unknown as typeof vscode.window.showInformationMessage;
  vscode.window.showErrorMessage = record("error") as unknown as typeof vscode.window.showErrorMessage;
}

/** A second session, so the board's own state is the assertion. */
async function onBoard(command: Array<string>): Promise<string> {
  const prober = new SshClient();
  const pin = (
    await prober.inspectHostKey({ host: HOST, port: PORT, username: USER }, undefined)
  ).asString();
  const client = new SshClient();
  try {
    await client.connect({
      endpoint: { host: HOST, port: PORT, username: USER },
      authentication: { kind: "password", password: new Secret(PASSWORD) },
      hostKeyPin: HostKeyFingerprint.parse(pin),
      proxyChain: [],
      keepaliveSeconds: 30,
    });
    const handle = await client.exec(
      ExecRequest.launch({
        executable: command[0],
        argv: command.slice(1),
        environment: {},
        allocatePty: false,
      })
    );
    const out: Array<Buffer> = [];
    for (;;) {
      const event = await handle.nextEvent();
      if (event === null) {
        break;
      }
      if (event.kind === "output") {
        out.push(Buffer.from(event.bytes));
      }
    }
    return Buffer.concat(out).toString("utf8").trim();
  } finally {
    await client.close();
  }
}

/** Runs the same readers the surface runs, so an invalid setting reports which
 * one and why instead of only the summary the notification carries. */
function settingDiagnosis(): Array<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return ["no workspace folder is open"];
  }
  const readers: Array<[string, () => unknown]> = [
    ["readProfileCatalog", () => readProfileCatalog()],
    ["readTarget", () => readTarget(folder)],
    ["readStrategy", () => readStrategy(folder)],
    ["readApplicationConfiguration", () => readApplicationConfiguration(folder)],
  ];
  const problems: Array<string> = [];
  for (const [name, read] of readers) {
    try {
      read();
    } catch (error) {
      const e = error as { code?: string; detail?: string };
      problems.push(`${name}: ${e.code ?? "unknown"} — ${e.detail ?? String(error)}`);
    }
  }
  return problems;
}

function messagesAt(level: string): Array<string> {
  return shown.filter((entry) => entry.level === level).map((entry) => entry.text);
}

/** Polls the status command until the run reaches the wanted state: the channel
 * closes after the command has already reported running. */
async function waitForApplicationState(pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    await vscode.commands.executeCommand("betelgeuz.status");
    const latest = shown
      .filter((entry) => entry.level === "info")
      .map((entry) => entry.text)
      .filter((text) => /target application:/.test(text))
      .pop();
    if (latest !== undefined && pattern.test(latest)) {
      return latest;
    }
    if (Date.now() > deadline) {
      return latest ?? "no status reported";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

suite("betelgeuz surface commands", () => {
  setup(async () => {
    stubDialogs();
    await onBoard(["/usr/bin/rm", "-f", REMOTE_APP]);
  });

  test("the fixture workspace's settings parse", () => {
    assert.deepEqual(settingDiagnosis(), []);
  });

  test("connects, enrolls the host key, and reads the descriptor", async () => {
    await vscode.commands.executeCommand("betelgeuz.connect");

    const connected = messagesAt("info").some((text) =>
      text.startsWith("Betelgeuz connected to")
    );
    assert.ok(connected, `notifications: ${JSON.stringify(messagesAt("info"))}`);
    assert.deepEqual(messagesAt("error"), [], JSON.stringify(shown, null, 2));
  });

  test("deploys the workspace's artifact", async () => {
    await vscode.commands.executeCommand("betelgeuz.deploy");

    const listing = await onBoard(["/usr/bin/ls", "-l", REMOTE_APP]);
    assert.match(listing, /-rwxr-xr-x/, `remote path ${REMOTE_APP}: ${listing}`);
    assert.deepEqual(messagesAt("error"), [], JSON.stringify(shown, null, 2));
  });

  test("runs the deployed application and reports its exit", async () => {
    await vscode.commands.executeCommand("betelgeuz.start");

    const reported = await waitForApplicationState(/exited/);
    assert.match(reported, /target application: exited/, `notifications: ${JSON.stringify(shown)}`);
    assert.deepEqual(messagesAt("error"), [], JSON.stringify(shown, null, 2));
  });

  test("stops the application and disconnects", async () => {
    await vscode.commands.executeCommand("betelgeuz.stop");
    await vscode.commands.executeCommand("betelgeuz.disconnect");

    assert.deepEqual(messagesAt("error"), [], JSON.stringify(shown, null, 2));
    assert.equal(await onBoard(["/usr/bin/pgrep", "-af", "betelgeuz-e2e"]), "");
  });
});
