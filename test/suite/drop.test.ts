/**
 * Hardware acceptance for plan §3 (Phase 3): a session that drops mid-run
 * reconnects with bounded backoff, re-validates identity, and reconciles the
 * foreground run against the target — never against the dead channel.
 *
 * The drop is caused on the board itself: the harness kills the board
 * account's unprivileged `sshd-session` processes, so the extension's channel
 * dies the way a network fault kills it — without an exit status, and without
 * the launched process being cleaned up. That is exactly the orphan case: the
 * strategy must hold the run, reconcile it after the reconnect by probing the
 * recorded pid, and stop it through the recorded process group.
 *
 * The suite registers only when BETELGEUZ_TEST_DROP=1: its artifact runs
 * until it is stopped, so the ordinary surface suite — which expects a run to
 * exit on its own — cannot share this invocation.
 */
import assert from "node:assert/strict";

import * as vscode from "vscode";

import {
  REMOTE_APP,
  USER,
  allMessages,
  clearMessages,
  messagesAt,
  onBoard,
  stubDialogs,
  waitForApplicationState,
} from "./helpers";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.env.BETELGEUZ_TEST_DROP !== "1") {
  suite("betelgeuz session drop", function () {
    test("needs a drop run (BETELGEUZ_TEST_DROP=1, a long-running artifact)", function () {
      this.skip();
    });
  });
} else {
  suite("betelgeuz session drop", () => {
    // One clean slate per suite: the tests below share the deployed artifact
    // and the running process, so a per-test setup must not touch them.
    suiteSetup(async () => {
      await onBoard(["/usr/bin/rm", "-f", REMOTE_APP]);
    });

    setup(() => {
      stubDialogs();
      clearMessages();
    });

    test("connects, enrolls the host key, and deploys the long-running artifact", async () => {
      await vscode.commands.executeCommand("betelgeuz.connect");
      assert.ok(
        messagesAt("info").some((text) => text.startsWith("Betelgeuz connected to")),
        `notifications: ${JSON.stringify(messagesAt("info"))}`
      );

      await vscode.commands.executeCommand("betelgeuz.deploy");
      const listing = await onBoard(["/usr/bin/ls", "-l", REMOTE_APP]);
      assert.match(listing, /-rwxr-xr-x/, `remote path ${REMOTE_APP}: ${listing}`);
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("starts the application and reports it running", async () => {
      await vscode.commands.executeCommand("betelgeuz.start");

      const reported = await waitForApplicationState(/running/);
      assert.match(reported, /target application: running/, JSON.stringify(allMessages()));
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("reconnects after a mid-run drop and restores the state from the target", async () => {
      // The kill takes this assertion session down with the extension's; the
      // effect on the board is the point, not the command's output.
      await onBoard(["/usr/bin/pkill", "-9", "-u", USER, "-f", "sshd-session"]);

      // The first reconnect attempt runs immediately and a full identity
      // handshake takes only a few seconds; polling before it lands would
      // only add the expected transient failures to the captured messages.
      await sleep(5_000);
      const reported = await waitForApplicationState(/running/, 45_000);
      assert.match(reported, /target application: running/, JSON.stringify(allMessages()));

      // The "running" report must rest on target evidence — a probe of the
      // recorded pid over the new session — so the process itself is the check.
      const alive = await onBoard(["/usr/bin/pgrep", "-f", "betelgeuz-e2e"]);
      assert.notEqual(
        alive,
        "",
        "the process was reported running but is not on the board"
      );
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("stops the orphaned run through its recorded process group", async () => {
      await vscode.commands.executeCommand("betelgeuz.stop");

      // The proof of the stop is the board, not the reported outcome.
      const gone = await onBoard(["/usr/bin/pgrep", "-f", "betelgeuz-e2e"]);
      assert.equal(gone, "", "the orphaned process survived the stop");
      const reported = await waitForApplicationState(/exited/, 10_000);
      assert.match(reported, /target application: exited/, JSON.stringify(allMessages()));
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("disconnects cleanly after the orphan was reconciled", async () => {
      await vscode.commands.executeCommand("betelgeuz.disconnect");

      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
      assert.equal(await onBoard(["/usr/bin/pgrep", "-f", "betelgeuz-e2e"]), "");
    });
  });
}
