/** VS Code configuration adapter for typed core profile inputs. */
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { BetelgeuzError } from "../errors";
import type {
  ApplicationConfiguration,
  ArtifactRecord,
  ProfileCatalog,
  ProxyHopProfile,
  TargetOverrides,
  TargetProfile,
} from "../protocol";
import {
  ATTACH_STRATEGY_KEY,
  PROFILES_KEY,
  TARGET_INLINE_PREFIX,
  TARGET_PROFILE_KEY,
  DEPLOY_ARGS_KEY,
  DEPLOY_ARTIFACT_PATH_KEY,
  DEPLOY_CWD_KEY,
  DEPLOY_ENVIRONMENT_KEY,
  DEPLOY_EXECUTABLE_KEY,
  DEPLOY_FILE_MODE_KEY,
  DEPLOY_REMOTE_PATH_KEY,
  DEPLOY_RUN_MODE_KEY,
  DEPLOY_SERVICE_UNIT_KEY,
} from "../protocol";

export function readProfileCatalog(): ProfileCatalog {
  const value = vscode.workspace.getConfiguration().get<unknown>(PROFILES_KEY, {});
  if (!isRecord(value)) {
    throw invalidSetting(PROFILES_KEY, "must be an object of named target profiles");
  }
  const catalog: ProfileCatalog = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      throw invalidSetting(`${PROFILES_KEY}.${name}`, "must be an object");
    }
    catalog[name] = parseTargetProfile(raw, `${PROFILES_KEY}.${name}`);
  }
  return catalog;
}

export function readTarget(folder: vscode.WorkspaceFolder): TargetOverrides {
  const config = folderConfiguration(folder);
  return {
    profile: optionalString(config.get<unknown>(TARGET_PROFILE_KEY), TARGET_PROFILE_KEY),
    host: readInlineString(config, "host"),
    port: readInlineNumber(config, "port"),
    username: readInlineString(config, "username"),
    credentialRef: readInlineString(config, "credentialRef"),
    hostKey: readInlineString(config, "hostKey"),
    deviceId: readInlineString(config, "deviceId"),
    boardId: readInlineString(config, "boardId"),
    socId: readInlineString(config, "socId"),
    keepaliveSeconds: readInlineNumber(config, "keepaliveSeconds"),
    proxyChain: optionalProxyChain(
      config.get<unknown>(`${TARGET_INLINE_PREFIX}proxyChain`),
      `${TARGET_INLINE_PREFIX}proxyChain`
    ),
  };
}

export function readStrategy(folder: vscode.WorkspaceFolder): string {
  const value = optionalString(
    folderConfiguration(folder).get<unknown>(ATTACH_STRATEGY_KEY),
    ATTACH_STRATEGY_KEY
  );
  return value?.trim() || "linux.ssh-app";
}

/** Reads the Phase 1 manual artifact and structured application settings. */
export async function readArtifactRecord(
  folder: vscode.WorkspaceFolder
): Promise<ArtifactRecord> {
  const config = folderConfiguration(folder);
  const path = requiredString(
    config.get<unknown>(DEPLOY_ARTIFACT_PATH_KEY),
    DEPLOY_ARTIFACT_PATH_KEY
  );
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new BetelgeuzError("artifact.missing", {
        detail: `${DEPLOY_ARTIFACT_PATH_KEY} must point to a regular file`,
      });
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      hash.update(chunk);
    }
    return {
      contentHash: hash.digest("hex"),
      path,
      size: info.size,
      targetName: config.get<string>("betelgeuz.deploy.localTarget", "artifact"),
    };
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      throw error;
    }
    throw new BetelgeuzError("artifact.missing", { cause: error });
  }
}

export function readApplicationConfiguration(
  folder: vscode.WorkspaceFolder
): ApplicationConfiguration {
  const config = folderConfiguration(folder);
  const remotePath = requiredString(
    config.get<unknown>(DEPLOY_REMOTE_PATH_KEY),
    DEPLOY_REMOTE_PATH_KEY
  );
  const args = optionalStringArray(config.get<unknown>(DEPLOY_ARGS_KEY), DEPLOY_ARGS_KEY);
  const cwd = optionalString(config.get<unknown>(DEPLOY_CWD_KEY), DEPLOY_CWD_KEY);
  const executable = optionalString(
    config.get<unknown>(DEPLOY_EXECUTABLE_KEY),
    DEPLOY_EXECUTABLE_KEY
  );
  const fileMode = optionalString(config.get<unknown>(DEPLOY_FILE_MODE_KEY), DEPLOY_FILE_MODE_KEY);
  const runMode = optionalString(config.get<unknown>(DEPLOY_RUN_MODE_KEY), DEPLOY_RUN_MODE_KEY);
  if (runMode !== undefined && runMode !== "foreground" && runMode !== "service") {
    throw invalidSetting(DEPLOY_RUN_MODE_KEY, "must be foreground or service");
  }
  const serviceUnit = optionalString(
    config.get<unknown>(DEPLOY_SERVICE_UNIT_KEY),
    DEPLOY_SERVICE_UNIT_KEY
  );
  const environment = optionalStringMap(
    config.get<unknown>(DEPLOY_ENVIRONMENT_KEY),
    DEPLOY_ENVIRONMENT_KEY
  );
  return {
    args,
    cwd: cwd ?? undefined,
    environment,
    executable: executable ?? undefined,
    fileMode: fileMode ?? undefined,
    remotePath,
    runMode: runMode ?? undefined,
    serviceUnit: serviceUnit ?? undefined,
  };
}

export function credentialFor(
  catalog: ProfileCatalog,
  target: TargetOverrides
): string {
  const override = nonEmptyString(target.credentialRef);
  if (override !== undefined) {
    return override;
  }
  const profile = nonEmptyString(target.profile);
  const credentialRef = profile === undefined
    ? undefined
    : nonEmptyString(catalog[profile]?.credentialRef);
  if (credentialRef === undefined) {
    throw invalidSetting(
      `${TARGET_INLINE_PREFIX}credentialRef`,
      "must resolve to a credential reference"
    );
  }
  return credentialRef;
}

export async function saveHostKey(
  folder: vscode.WorkspaceFolder,
  catalog: ProfileCatalog,
  target: TargetOverrides,
  fingerprint: string
): Promise<void> {
  const profileName = target.profile?.trim();
  if (profileName !== undefined && catalog[profileName] !== undefined) {
    // Re-read immediately before the write so the whole-object update does not
    // drop profiles enrolled by another folder in the meantime.
    const current = readProfileCatalog();
    const existing = current[profileName] ?? catalog[profileName];
    const nextCatalog = {
      ...current,
      [profileName]: { ...existing, hostKey: fingerprint },
    };
    await vscode.workspace.getConfiguration().update(
      PROFILES_KEY,
      nextCatalog,
      vscode.ConfigurationTarget.Global
    );
    return;
  }
  await folderConfiguration(folder).update(
    `${TARGET_INLINE_PREFIX}hostKey`,
    fingerprint,
    vscode.ConfigurationTarget.WorkspaceFolder
  );
}

export function folderConfiguration(
  folder: vscode.WorkspaceFolder
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(undefined, folder.uri);
}

function parseTargetProfile(
  raw: Record<string, unknown>,
  path: string
): TargetProfile {
  const port = optionalNumber(raw.port, `${path}.port`);
  const keepaliveSeconds = optionalNumber(raw.keepaliveSeconds, `${path}.keepaliveSeconds`);
  return {
    host: requiredString(raw.host, `${path}.host`),
    username: requiredString(raw.username, `${path}.username`),
    credentialRef: requiredString(raw.credentialRef, `${path}.credentialRef`),
    ...(port == null ? {} : { port }),
    ...(keepaliveSeconds == null ? {} : { keepaliveSeconds }),
    hostKey: optionalString(raw.hostKey, `${path}.hostKey`),
    deviceId: optionalString(raw.deviceId, `${path}.deviceId`),
    boardId: optionalString(raw.boardId, `${path}.boardId`),
    socId: optionalString(raw.socId, `${path}.socId`),
    proxyChain: optionalProxyChain(raw.proxyChain, `${path}.proxyChain`) ?? undefined,
  };
}

function readInlineString(
  config: vscode.WorkspaceConfiguration,
  name: string
): string | null | undefined {
  const key = `${TARGET_INLINE_PREFIX}${name}`;
  return optionalString(config.get<unknown>(key), key);
}

function readInlineNumber(
  config: vscode.WorkspaceConfiguration,
  name: string
): number | null | undefined {
  const key = `${TARGET_INLINE_PREFIX}${name}`;
  return optionalNumber(config.get<unknown>(key), key);
}

function optionalProxyChain(
  value: unknown,
  path: string
): Array<ProxyHopProfile> | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (!Array.isArray(value)) {
    throw invalidSetting(path, "must be an array");
  }
  return value.map((hop, index) => {
    const hopPath = `${path}[${index}]`;
    if (!isRecord(hop)) {
      throw invalidSetting(hopPath, "must be an object");
    }
    const port = optionalNumber(hop.port, `${hopPath}.port`);
    return {
      host: requiredString(hop.host, `${hopPath}.host`),
      username: requiredString(hop.username, `${hopPath}.username`),
      credentialRef: requiredString(hop.credentialRef, `${hopPath}.credentialRef`),
      hostKey: requiredString(hop.hostKey, `${hopPath}.hostKey`),
      ...(port == null ? {} : { port }),
    };
  });
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidSetting(path, "must be a non-empty string");
  }
  return value;
}

function optionalString(value: unknown, path: string): string | null | undefined {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  throw invalidSetting(path, "must be a string");
}

function optionalNumber(value: unknown, path: string): number | null | undefined {
  if (value === undefined || value === null || typeof value === "number") {
    return value;
  }
  throw invalidSetting(path, "must be a number");
}

function optionalStringArray(value: unknown, path: string): Array<string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidSetting(path, "must be an array of strings");
  }
  const items: Array<unknown> = value;
  return items.map((item) => String(item));
}

function optionalStringMap(
  value: unknown,
  path: string
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidSetting(path, "must be an object of string values");
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw invalidSetting(path, "must be an object of string values");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value !== undefined && value !== null && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function invalidSetting(path: string, reason: string): BetelgeuzError {
  return new BetelgeuzError("config.invalid", { detail: `${path} ${reason}` });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
