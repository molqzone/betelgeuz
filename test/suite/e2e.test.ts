/**
 * End-to-end coverage for the surface layer: the commands a user runs, through
 * the real extension host, against a real board. The dialogs are answered by
 * `helpers.ts`; the board credential and artifact come from the environment.
 */
import assert from "node:assert/strict";

import * as vscode from "vscode";

import {
  REMOTE_APP,
  allMessages,
  messagesAt,
  onBoard,
  settingProblems,
  stubDialogs,
  waitForApplicationState,
} from "./helpers";

/** The ordinary surface suite is the plain manual artifact run. A special
 *  run — the session drop, the CMake source, or the small-core firmware —
 *  carries its own workspace settings and its own suite, so this one steps
 *  aside rather than deploying a workspace it does not describe. */
const SPECIAL_RUN =
  process.env.BETELGEUZ_TEST_DROP === "1" ||
  process.env.BETELGEUZ_TEST_CMAKE === "1" ||
  process.env.BETELGEUZ_TEST_RPROC === "1";

if (SPECIAL_RUN) {
  suite("betelgeuz surface commands", function () {
    test("needs a plain manual run (no BETELGEUZ_TEST_DROP/CMAKE/RPROC)", function () {
      this.skip();
    });
  });
} else {
  suite("betelgeuz surface commands", () => {
  // One clean slate per suite: the later tests run the artifact this suite
  // deploys, so a per-test setup must not delete it.
  suiteSetup(async () => {
    await onBoard(["/usr/bin/rm", "-f", REMOTE_APP]);
  });

  setup(() => {
    stubDialogs();
  });

  test("the fixture workspace's settings parse", () => {
    assert.deepEqual(settingProblems(), []);
  });

  test("connects, enrolls the host key, and reads the descriptor", async () => {
    await vscode.commands.executeCommand("betelgeuz.connect");

    const connected = messagesAt("info").some((text) =>
      text.startsWith("Betelgeuz connected to")
    );
    assert.ok(connected, `notifications: ${JSON.stringify(messagesAt("info"))}`);
    assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
  });

  test("deploys the workspace's artifact", async () => {
    await vscode.commands.executeCommand("betelgeuz.deploy");

    const listing = await onBoard(["/usr/bin/ls", "-l", REMOTE_APP]);
    assert.match(listing, /-rwxr-xr-x/, `remote path ${REMOTE_APP}: ${listing}`);
    assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
  });

  test("runs the deployed application and reports its exit", async () => {
    await vscode.commands.executeCommand("betelgeuz.start");

    const reported = await waitForApplicationState(/exited/);
    assert.match(reported, /Linux application.*exited/, `notifications: ${JSON.stringify(allMessages())}`);
    assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
  });

  test("stops the application and disconnects", async () => {
    await vscode.commands.executeCommand("betelgeuz.stop");
    await vscode.commands.executeCommand("betelgeuz.disconnect");

    assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    assert.equal(await onBoard(["/usr/bin/pgrep", "-af", "betelgeuz-e2e"]), "");
  });
});
}
