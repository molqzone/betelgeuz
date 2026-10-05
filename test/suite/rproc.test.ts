/**
 * Hardware acceptance for plan §6 (Phase 5): the `linux.remoteproc` strategy
 * end to end through the extension host — identity handshake, the post-bind
 * interface probe, a firmware deploy that stops the running core with the
 * surface's explicit confirmation, lifecycle verbs, and restore.
 *
 * The suite registers only when BETELGEUZ_TEST_RPROC=1: it stops and starts
 * the board's small core, so the ordinary surface suite — which runs a Linux
 * application — cannot share the invocation. The target must expose
 * `/sys/class/remoteproc/` with `cv181x-c906_1` and meet the least-privilege
 * setup in docs/dev/remoteproc-setup.md (the firmware directory writable by
 * the connecting account, the control writes through the sudo whitelist).
 */
import assert from "node:assert/strict";

import * as vscode from "vscode";

import {
  REMOTE_FIRMWARE,
  allMessages,
  clearMessages,
  messagesAt,
  onBoard,
  onBoardCoreState,
  settingProblems,
  stubDialogs,
} from "./helpers";

if (process.env.BETELGEUZ_TEST_RPROC !== "1") {
  suite("betelgeuz linux.remoteproc", function () {
    test("needs a firmware run (BETELGEUZ_TEST_RPROC=1)", function () {
      this.skip();
    });
  });
} else {
  suite("betelgeuz linux.remoteproc", () => {
    suiteSetup(async () => {
      // One clean slate: the previous run's firmware and retained images.
      await onBoard(["/usr/bin/rm", "-f", REMOTE_FIRMWARE, `${REMOTE_FIRMWARE}.betelgeuz-prev-*`]);
    });

    setup(() => {
      stubDialogs();
      clearMessages();
    });

    test("the fixture workspace's settings parse", () => {
      assert.deepEqual(settingProblems(), []);
    });

    test("connects, enrolls the host key, and probes the remoteproc interface", async () => {
      await vscode.commands.executeCommand("betelgeuz.connect");

      assert.ok(
        messagesAt("info").some((text) => text.startsWith("Betelgeuz connected to")),
        `notifications: ${JSON.stringify(messagesAt("info"))}`
      );
      // The post-bind strategy probe succeeded: no incompatibility surfaced.
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("deploys the firmware image through the selected strategy", async () => {
      await vscode.commands.executeCommand("betelgeuz.deploy");

      // The board is the assertion: the staged image became the selected
      // firmware — the attribute holds a NAME the kernel resolves — and the
      // core is running again.
      const core = await onBoardCoreState();
      assert.equal(core.state, "running", `core state: ${JSON.stringify(core)}`);
      assert.equal(core.firmware, "rtos.elf", `core firmware: ${JSON.stringify(core)}`);
      const listing = await onBoard(["/usr/bin/ls", "-l", REMOTE_FIRMWARE]);
      assert.match(listing, /-rw/, `firmware path ${REMOTE_FIRMWARE}: ${listing}`);
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("reports the small-core state as execution state", async () => {
      await vscode.commands.executeCommand("betelgeuz.status");

      assert.ok(
        messagesAt("info").some((text) => /Betelgeuz Linux small-core firmware: running/.test(text)),
        `notifications: ${JSON.stringify(allMessages())}`
      );
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("stops and starts the core through the generic verbs", async () => {
      await vscode.commands.executeCommand("betelgeuz.stop");
      assert.equal((await onBoardCoreState()).state, "offline");

      await vscode.commands.executeCommand("betelgeuz.start");
      assert.equal((await onBoardCoreState()).state, "running");
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });

    test("disconnects cleanly, leaving the core running", async () => {
      await vscode.commands.executeCommand("betelgeuz.disconnect");

      // The small core runs independently of the session (plan §6).
      assert.equal((await onBoardCoreState()).state, "running");
      assert.deepEqual(messagesAt("error"), [], JSON.stringify(allMessages(), null, 2));
    });
  });
}
