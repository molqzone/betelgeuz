/**
 * Shared harness for the end-to-end surface suites.
 *
 * The extension host runs headless, so nothing answers its dialogs. The stubs
 * below stand in for the user — they choose the same items the QuickPicks
 * offer and type the credential the environment holds — and every message the
 * extension shows is captured, so a command that reaches the user is
 * observable.
 *
 * The board credential comes from the environment: BETELGEUZ_TEST_PASSWORD
 * for password authentication, or BETELGEUZ_TEST_KEY (a private key file
 * path) when the board authorizes a key instead.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import * as vscode from "vscode";

import { Secret } from "../../src/secret";
import {
  readApplicationConfiguration,
  readProfileCatalog,
  readStrategyConfiguration,
  readStrategy,
  readTarget,
} from "../../src/surface/settings";
import { ExecRequest, HostKeyFingerprint, parseLaunchPidLine } from "../../src/transport/index";
import { SshClient } from "../../src/transport/ssh";

export const HOST = process.env.BETELGEUZ_TEST_HOST ?? "";
export const PORT = Number(process.env.BETELGEUZ_TEST_PORT ?? "22");
export const USER = process.env.BETELGEUZ_TEST_USER ?? "root";
export const PASSWORD = process.env.BETELGEUZ_TEST_PASSWORD ?? "";
export const KEY_FILE = process.env.BETELGEUZ_TEST_KEY === undefined
  ? ""
  : process.env.BETELGEUZ_TEST_KEY.replace(/^~(?=$|\/)/, homedir());
export const REMOTE_APP = "/tmp/betelgeuz-e2e/app";
/** The small-core firmware workspace's remote firmware location. */
export const REMOTE_FIRMWARE = "/lib/firmware/rtos.elf";
/** The remoteproc instance the fixture workspace configures. */
export const RPROC_INSTANCE = "cv181x-c906_1";
/** True when the run targets the small-core firmware suite. */
export const RPROC = process.env.BETELGEUZ_TEST_RPROC === "1";

const shown: Array<{ level: string; text: string }> = [];

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

/** The credential the stubs answer with and the board assertions connect with. */
function authentication():
  | { kind: "password"; password: Secret }
  | { kind: "privateKey"; privateKey: Secret } {
  if (KEY_FILE !== "") {
    return { kind: "privateKey", privateKey: new Secret(readFileSync(KEY_FILE, "utf8")) };
  }
  return { kind: "password", password: new Secret(PASSWORD) };
}

/** Deterministic answers to whatever the surface asks. `preferLabel` steers
 *  QuickPicks that offer more than the Betelgeuz flows — the CMake kit picker,
 *  whose items arrive as a thenable and whose wanted entry is matched by
 *  label — while the credential and retention picks keep their answers. */
export function stubDialogs(preferLabel?: RegExp): void {
  const pick = async (items: unknown): Promise<unknown> => {
    const list: Array<unknown> = Array.isArray(items)
      ? items
      : isThenable(items)
        ? await (items as Promise<Array<unknown>>)
        : [items];
    if (KEY_FILE !== "") {
      const keyMethod = list.find(
        (item) => (item as { value?: unknown } | undefined)?.value === "privateKey"
      );
      if (keyMethod !== undefined) {
        return keyMethod;
      }
    }
    if (preferLabel !== undefined) {
      const preferred = list.find((item) =>
        preferLabel.test(String((item as { label?: unknown } | undefined)?.label ?? ""))
      );
      if (preferred !== undefined) {
        return preferred;
      }
    }
    return list[0];
  };
  vscode.window.showQuickPick = pick as unknown as typeof vscode.window.showQuickPick;
  // The one input box in the flows is the password prompt — or, for a key
  // credential, the passphrase prompt, where an empty answer means none.
  vscode.window.showInputBox = (async () =>
    KEY_FILE !== "" ? "" : PASSWORD) as unknown as typeof vscode.window.showInputBox;
  vscode.window.showOpenDialog = (async () =>
    KEY_FILE !== "" ? [vscode.Uri.file(KEY_FILE)] : []) as unknown as typeof vscode.window.showOpenDialog;
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
export async function onBoard(command: Array<string>): Promise<string> {
  const prober = new SshClient();
  const pin = (
    await prober.inspectHostKey({ host: HOST, port: PORT, username: USER }, undefined)
  ).asString();
  const client = new SshClient();
  try {
    await client.connect({
      endpoint: { host: HOST, port: PORT, username: USER },
      authentication: authentication(),
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
    // The launcher's pid marker line is transport furniture, not the
    // command's output; the assertions read the command's output alone.
    const lines = Buffer.concat(out).toString("utf8").split("\n");
    if (lines.length > 1 && parseLaunchPidLine(lines[0].trim()) !== undefined) {
      lines.shift();
    }
    return lines.join("\n").trim();
  } finally {
    await client.close();
  }
}

export function messagesAt(level: string): Array<string> {
  return shown.filter((entry) => entry.level === level).map((entry) => entry.text);
}

/** Everything captured so far, for the failure reports. */
export function allMessages(): Array<{ level: string; text: string }> {
  return shown;
}

/** Drops the captured messages, so a test asserts only its own window. */
export function clearMessages(): void {
  shown.length = 0;
}

/** Runs the same readers the surface runs, so an invalid setting reports which
 * one and why instead of only the summary the notification carries. */
export function settingProblems(): Array<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return ["no workspace folder is open"];
  }
  const readers: Array<[string, () => unknown]> = [
    ["readProfileCatalog", () => readProfileCatalog()],
    ["readTarget", () => readTarget(folder)],
    ["readStrategy", () => readStrategy(folder)],
    // The active strategy's own settings: the application strategy's
    // deploy.* keys, or the small-core strategy's instance and firmware path.
    ["readStrategyConfiguration", () => readStrategyConfiguration(folder)],
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

/** Polls the status command until the run reaches the wanted state: the channel
 * closes after the command has already reported running. */
export async function waitForApplicationState(
  pattern: RegExp,
  deadlineMs = 30_000
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    await vscode.commands.executeCommand("betelgeuz.status");
    const latest = messagesAt("info")
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

/** Reads the small core's state off the board, so an assertion rests on the
 *  target rather than on what the extension reported. */
export async function onBoardCoreState(): Promise<{ firmware: string; state: string }> {
  const state = await onBoard(["cat", "/sys/class/remoteproc/remoteproc0/state"]);
  const firmware = await onBoard(["cat", "/sys/class/remoteproc/remoteproc0/firmware"]);
  return { firmware, state };
}
