/** WorkspaceState persistence for the last verified, non-secret target identity. */
import type * as vscode from "vscode";

import type {
  AttachResult,
  ResolvedProfile,
  VerifiedTargetIdentity,
} from "../protocol";

const PERSISTED_ATTACH_KEY = "betelgeuz.verifiedAttaches";

export interface PersistedAttach {
  identity: VerifiedTargetIdentity;
  profile: ResolvedProfile;
  strategyId: string;
  verifiedAt: string;
}

export function persistedAttachFrom(result: AttachResult): PersistedAttach {
  return {
    identity: result.identity,
    profile: result.profile,
    strategyId: result.strategyId,
    verifiedAt: new Date().toISOString(),
  };
}

export async function persistAttach(
  state: vscode.Memento,
  folderKey: string,
  snapshot: PersistedAttach
): Promise<void> {
  const current = state.get<Record<string, PersistedAttach>>(PERSISTED_ATTACH_KEY, {});
  await state.update(PERSISTED_ATTACH_KEY, { ...current, [folderKey]: snapshot });
}

export function readPersistedAttach(
  state: vscode.Memento,
  folderKey: string
): PersistedAttach | undefined {
  const value = state.get<unknown>(PERSISTED_ATTACH_KEY, {});
  if (!isRecord(value)) {
    return undefined;
  }
  const snapshot = value[folderKey];
  if (!isRecord(snapshot) || !isRecord(snapshot.identity) || !isRecord(snapshot.profile)) {
    return undefined;
  }
  const identity = snapshot.identity;
  const profile = snapshot.profile;
  if (
    typeof identity.host !== "string" ||
    typeof identity.hostKeyFingerprint !== "string" ||
    typeof identity.port !== "number" ||
    !isRecord(identity.descriptor) ||
    typeof profile.host !== "string" ||
    typeof profile.username !== "string" ||
    typeof profile.port !== "number" ||
    typeof snapshot.strategyId !== "string" ||
    typeof snapshot.verifiedAt !== "string"
  ) {
    return undefined;
  }
  return snapshot as unknown as PersistedAttach;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
