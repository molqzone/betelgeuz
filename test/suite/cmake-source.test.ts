/**
 * End-to-end coverage for the CMake-source deploy path (plan Phase 2): the
 * artifact comes from the workspace's CMake project, not from a manual path,
 * and reaches the same verified board through the same deploy pipeline.
 *
 * The build itself is not Betelgeuz's business (it never invokes a build), so
 * the harness runs the fixture's preset build through the cmake CLI before the
 * suite starts — exactly what a workspace's build owner does before a Deploy
 * exists to consume it. CMake Tools is deliberately not installed for this
 * run: its API needs a preset or kit selection a headless instance cannot
 * answer, so this run exercises the plan's File API fallback instead (plan
 * §6, §9). The API-first path stays covered by the unit suite and the
 * real-editor run.
 *
 * Registered only when BETELGEUZ_TEST_CMAKE=1.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

import {
  REMOTE_APP,
  allMessages,
  clearMessages,
  messagesAt,
  onBoard,
  stubDialogs,
  waitForApplicationState,
} from "./helpers";

const run = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for the build to have produced the target's artifact. */
async function waitForArtifact(path: string, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`the build did not produce ${path} within ${deadlineMs} ms`);
    }
    await sleep(250);
  }
}

if (process.env.BETELGEUZ_TEST_CMAKE !== "1") {
  suite("betelgeuz cmake deploy", function () {
    test("needs a CMake run (BETELGEUZ_TEST_CMAKE=1)", function () {
      this.skip();
    });
  });
} else {
  suite("betelgeuz cmake deploy", () => {
    suiteSetup(async function () {
      this.timeout(180_000);
      stubDialogs();
      clearMessages();
      await onBoard(["/usr/bin/rm", "-f", REMOTE_APP]);

      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder !== undefined, "the fixture workspace is not open");
      const source = folder.uri.fsPath;
      await run("cmake", ["--preset", "zig-riscv64"], { cwd: source });
      await run("cmake", ["--build", "--preset", "zig-riscv64"], { cwd: source });
      await waitForArtifact(join(source, "build", "bgapp"));
    });

    setup(() => {
      stubDialogs();
      clearMessages();
    });

    test("connects and deploys the CMake-built artifact", async () => {
      await vscode.commands.executeCommand("betelgeuz.connect");
      assert.ok(
        messagesAt("info").some((text) => text.startsWith("Betelgeuz connected to")),
        `notifications: ${JSON.stringify(messagesAt("info"))}`
      );

      await vscode.commands.executeCommand("betelgeuz.deploy");
      const listing = await onBoard(["/usr/bin/ls", "-l", REMOTE_APP]);
      assert.match(
        listing,
        /-rwxr-xr-x/,
        `remote path ${REMOTE_APP}: ${listing}\nmessages: ${JSON.stringify(allMessages(), null, 2)}`
      );
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("runs the deployed artifact and reports its exit", async () => {
      await vscode.commands.executeCommand("betelgeuz.start");

      const reported = await waitForApplicationState(/exited/);
      assert.match(reported, /target application: exited/, JSON.stringify(allMessages()));
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("stops and disconnects, leaving nothing behind", async () => {
      await vscode.commands.executeCommand("betelgeuz.stop");
      await vscode.commands.executeCommand("betelgeuz.disconnect");

      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
      assert.equal(await onBoard(["/usr/bin/pgrep", "-f", "betelgeuz-e2e"]), "");
    });
  });
}
