/**
 * Workspace memory for the artifact a deploy uses.
 *
 * The manual source names a file once; after that the workspace's choice is
 * remembered so a rebuild under the same path needs no setting edit. The
 * remembered value is only ever a path — never credential material — and a
 * configured `betelgeuz.deploy.artifactPath` always wins over it.
 */
import type * as vscode from "vscode";

const REMEMBERED_ARTIFACT_KEY = "betelgeuz.artifactPath";

export async function rememberArtifact(
  storage: vscode.Memento,
  folderKey: string,
  path: string
): Promise<void> {
  const current = storage.get<Record<string, string>>(REMEMBERED_ARTIFACT_KEY, {});
  await storage.update(REMEMBERED_ARTIFACT_KEY, { ...current, [folderKey]: path });
}

export function readRememberedArtifact(
  storage: vscode.Memento,
  folderKey: string
): string | undefined {
  const value = storage.get<unknown>(REMEMBERED_ARTIFACT_KEY, {});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const path = (value as Record<string, unknown>)[folderKey];
  return typeof path === "string" && path.trim() !== "" ? path : undefined;
}
