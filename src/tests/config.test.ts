import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  CredentialSecrets,
  ProfileCatalog,
  TargetOverrides,
} from "../protocol";
import {
  ATTACH_PREFIX,
  ATTACH_STRATEGY_KEY,
  CONFIG_KEY_PATTERNS,
  DEPLOY_ARGS_KEY,
  DEPLOY_ARTIFACT_KEY,
  DEPLOY_ARTIFACT_PATH_KEY,
  DEPLOY_CWD_KEY,
  DEPLOY_ENVIRONMENT_KEY,
  DEPLOY_EXECUTABLE_KEY,
  DEPLOY_FILE_MODE_KEY,
  DEPLOY_LOCAL_TARGET_KEY,
  DEPLOY_REMOTE_PATH_KEY,
  DEPLOY_RUN_COMMAND_KEY,
  DEPLOY_RUN_MODE_KEY,
  DEPLOY_SERVICE_UNIT_KEY,
  FIXED_CONFIG_KEYS,
  PROFILES_KEY,
  TARGET_INLINE_PREFIX,
  TARGET_PROFILE_KEY,
  strategyKey,
} from "../protocol";

describe("settings shapes", () => {
  it("keeps the configuration key catalog stable", () => {
    expect(FIXED_CONFIG_KEYS).toMatchInlineSnapshot(`
      [
        "betelgeuz.profiles",
        "betelgeuz.target.profile",
        "betelgeuz.target.host",
        "betelgeuz.target.port",
        "betelgeuz.target.username",
        "betelgeuz.target.credentialRef",
        "betelgeuz.target.hostKey",
        "betelgeuz.target.deviceId",
        "betelgeuz.target.boardId",
        "betelgeuz.target.socId",
        "betelgeuz.target.keepaliveSeconds",
        "betelgeuz.target.proxyChain",
        "betelgeuz.attach.strategy",
        "betelgeuz.deploy.localTarget",
        "betelgeuz.deploy.artifactPath",
        "betelgeuz.deploy.artifact",
        "betelgeuz.deploy.remotePath",
        "betelgeuz.deploy.executable",
        "betelgeuz.deploy.args",
        "betelgeuz.deploy.cwd",
        "betelgeuz.deploy.environment",
        "betelgeuz.deploy.fileMode",
        "betelgeuz.deploy.runCommand",
        "betelgeuz.deploy.runMode",
        "betelgeuz.deploy.serviceUnit",
      ]
    `);
    expect(CONFIG_KEY_PATTERNS).toEqual(["betelgeuz.target.", "betelgeuz.attach."]);
  });

  it("contributes every fixed setting and the implemented target commands", () => {
    const manifest = JSON.parse(
      readFileSync("package.json", "utf8")
    ) as {
      contributes: {
        commands: Array<{ command: string }>;
        configuration: { properties: Record<string, unknown> };
      };
    };
    const properties = manifest.contributes.configuration.properties;
    for (const key of FIXED_CONFIG_KEYS) {
      expect(properties).toHaveProperty(key);
    }
    expect(manifest.contributes.commands.map(({ command }) => command)).toEqual([
      "betelgeuz.selectSshTarget",
      "betelgeuz.connect",
      "betelgeuz.disconnect",
      "betelgeuz.inspectAttach",
      "betelgeuz.deploy",
      "betelgeuz.start",
      "betelgeuz.stop",
      "betelgeuz.restart",
      "betelgeuz.status",
      "betelgeuz.logs",
    ]);
  });

  it("builds strategy keys from the full strategy ID", () => {
    expect(strategyKey("linux.remoteproc", "instance")).toBe(
      "betelgeuz.attach.linux.remoteproc.instance"
    );
    expect(strategyKey("linux.remoteproc", "firmwarePath")).toBe(
      "betelgeuz.attach.linux.remoteproc.firmwarePath"
    );
    expect(ATTACH_PREFIX).toBe("betelgeuz.attach.");
    expect(ATTACH_STRATEGY_KEY).toBe("betelgeuz.attach.strategy");
    expect(PROFILES_KEY).toBe("betelgeuz.profiles");
    expect(TARGET_PROFILE_KEY).toBe("betelgeuz.target.profile");
    expect(TARGET_INLINE_PREFIX).toBe("betelgeuz.target.");
    expect([
      DEPLOY_LOCAL_TARGET_KEY,
      DEPLOY_ARTIFACT_PATH_KEY,
      DEPLOY_ARTIFACT_KEY,
      DEPLOY_REMOTE_PATH_KEY,
      DEPLOY_EXECUTABLE_KEY,
      DEPLOY_ARGS_KEY,
      DEPLOY_CWD_KEY,
      DEPLOY_ENVIRONMENT_KEY,
      DEPLOY_FILE_MODE_KEY,
      DEPLOY_RUN_COMMAND_KEY,
      DEPLOY_RUN_MODE_KEY,
      DEPLOY_SERVICE_UNIT_KEY,
    ]).toEqual([
      "betelgeuz.deploy.localTarget",
      "betelgeuz.deploy.artifactPath",
      "betelgeuz.deploy.artifact",
      "betelgeuz.deploy.remotePath",
      "betelgeuz.deploy.executable",
      "betelgeuz.deploy.args",
      "betelgeuz.deploy.cwd",
      "betelgeuz.deploy.environment",
      "betelgeuz.deploy.fileMode",
      "betelgeuz.deploy.runCommand",
      "betelgeuz.deploy.runMode",
      "betelgeuz.deploy.serviceUnit",
    ]);
  });

  it("target profile serializes with camelCase settings keys", () => {
    const catalog: ProfileCatalog = {
      "my-board": {
        host: "192.168.7.1",
        port: 22,
        username: "root",
        credentialRef: "board-key",
        hostKey: "SHA256:example",
        deviceId: "board-1",
        proxyChain: [
          {
            host: "jump.local",
            port: 22,
            username: "jump",
            credentialRef: "jump-key",
            hostKey: "SHA256:jump",
          },
        ],
      },
    };
    expect(JSON.stringify(catalog, null, 2)).toMatchInlineSnapshot(`
      "{
        "my-board": {
          "host": "192.168.7.1",
          "port": 22,
          "username": "root",
          "credentialRef": "board-key",
          "hostKey": "SHA256:example",
          "deviceId": "board-1",
          "proxyChain": [
            {
              "host": "jump.local",
              "port": 22,
              "username": "jump",
              "credentialRef": "jump-key",
              "hostKey": "SHA256:jump"
            }
          ]
        }
      }"
    `);
  });

  it("workspace overrides only carry populated fields", () => {
    const target: TargetOverrides = {
      profile: "my-board",
      host: "board.local",
      credentialRef: "board",
    };
    expect(JSON.stringify(target, null, 2)).toMatchInlineSnapshot(`
      "{
        "profile": "my-board",
        "host": "board.local",
        "credentialRef": "board"
      }"
    `);
  });

  it("credential secrets stay one-use material per reference", () => {
    const secrets: CredentialSecrets = {
      board: { password: "one-use-secret" },
    };
    expect(JSON.stringify(secrets, null, 2)).toMatchInlineSnapshot(`
      "{
        "board": {
          "password": "one-use-secret"
        }
      }"
    `);
  });


});
