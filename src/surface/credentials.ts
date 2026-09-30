/** VS Code SecretStorage prompt and serialization boundary for SSH credentials. */
import * as vscode from "vscode";

import { BetelgeuzError } from "../errors";
import type { CredentialMaterial } from "../protocol";

export async function loadCredential(
  storage: vscode.SecretStorage,
  credentialRef: string
): Promise<CredentialMaterial | undefined> {
  const storageKey = credentialStorageKey(credentialRef);
  const saved = await storage.get(storageKey);
  if (saved !== undefined) {
    return parseCredential(saved);
  }
  const method = await vscode.window.showQuickPick(
    [
      { label: "Password", value: "password" },
      { label: "Private key file", value: "privateKey" },
    ],
    { placeHolder: `Choose authentication for credential '${credentialRef}'` }
  );
  if (method === undefined) {
    return undefined;
  }

  const material = method.value === "password"
    ? await readPassword(credentialRef)
    : await readPrivateKey();
  if (material === undefined) {
    return undefined;
  }

  const retention = await vscode.window.showQuickPick(
    [
      { label: "Store securely", description: "Save in VS Code SecretStorage", value: "store" },
      { label: "Use once", description: "Ask again next time", value: "once" },
    ],
    { placeHolder: "Choose how to keep this credential" }
  );
  if (retention === undefined) {
    clearCredential(material);
    return undefined;
  }
  if (retention.value === "store") {
    await storage.store(storageKey, JSON.stringify(material));
  }
  return material;
}

export function clearCredential(material: CredentialMaterial): void {
  if (material.password !== undefined) {
    material.password = "";
  }
  if (material.privateKey !== undefined) {
    material.privateKey = "";
  }
  if (material.passphrase !== undefined) {
    material.passphrase = "";
  }
}

function credentialStorageKey(credentialRef: string): string {
  return `betelgeuz.credential.${encodeURIComponent(credentialRef)}`;
}

async function readPassword(
  credentialRef: string
): Promise<CredentialMaterial | undefined> {
  const password = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    prompt: `SSH password for credential '${credentialRef}'`,
  });
  return password === undefined || password === "" ? undefined : { password };
}

async function readPrivateKey(): Promise<CredentialMaterial | undefined> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Use private key",
  });
  const keyFile = selected?.[0];
  if (keyFile === undefined) {
    return undefined;
  }
  const privateKey = Buffer.from(await vscode.workspace.fs.readFile(keyFile)).toString("utf8");
  const passphrase = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    prompt: "Private key passphrase, if required",
    placeHolder: "Leave empty if the key has no passphrase",
  });
  if (passphrase === undefined) {
    return undefined;
  }
  return passphrase === "" ? { privateKey } : { privateKey, passphrase };
}

function parseCredential(serialized: string): CredentialMaterial {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw invalidCredential("contains invalid saved data", error);
  }
  if (!isRecord(value)) {
    throw invalidCredential("must contain an authentication object");
  }
  const password = value.password;
  const privateKey = value.privateKey;
  const passphrase = value.passphrase;
  if (
    typeof privateKey === "string" &&
    privateKey !== "" &&
    password === undefined &&
    (passphrase === undefined || typeof passphrase === "string")
  ) {
    return {
      privateKey,
      ...(typeof passphrase === "string" && passphrase !== "" ? { passphrase } : {}),
    };
  }
  if (
    typeof password === "string" &&
    password !== "" &&
    privateKey === undefined &&
    passphrase === undefined
  ) {
    return { password };
  }
  throw invalidCredential(
    "must contain one password or one private key with an optional passphrase"
  );
}

function invalidCredential(reason: string, cause?: unknown): BetelgeuzError {
  return new BetelgeuzError("config.invalid", {
    detail: `SecretStorage credential ${reason}`,
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
