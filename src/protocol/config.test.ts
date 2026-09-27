import { describe, expect, it } from "vitest";

import type {
  CredentialSecrets,
  HardwareDescriptor,
  ProfileCatalog,
  TargetOverrides,
} from "./index";

describe("settings and descriptor shapes", () => {
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

  it("descriptor tolerates missing fields as unknown", () => {
    const descriptor: HardwareDescriptor = {
      deviceId: "abc-123",
      socId: "rk3506",
      model: "my-board",
    };
    expect(JSON.stringify(descriptor, null, 2)).toMatchInlineSnapshot(`
      "{
        "deviceId": "abc-123",
        "socId": "rk3506",
        "model": "my-board"
      }"
    `);
    const empty: HardwareDescriptor = {};
    expect(empty.deviceId).toBeUndefined();
  });
});
