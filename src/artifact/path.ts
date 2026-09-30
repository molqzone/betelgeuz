/**
 * Resolving what `betelgeuz.deploy.artifactPath` names.
 *
 * The setting may point at a file or at the directory a build writes into. A
 * directory is resolved by content, not by listing choice: the ELF binaries it
 * holds, and exactly one of them. A directory holding several is reported with
 * their names rather than resolved by timestamp or size, because picking the
 * "latest" silently deploys a build the user did not ask for.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { BetelgeuzError } from "../errors";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** The file a configured artifact path names, resolving a directory. */
export async function resolveArtifactFile(path: string): Promise<string> {
  const info = await stat(path).catch((error: unknown) => {
    throw new BetelgeuzError("artifact.missing", {
      detail: `${path} does not exist`,
      cause: error,
    });
  });
  if (!info.isDirectory()) {
    return path;
  }
  const entries = (await readdir(path)).sort();
  const binaries: Array<string> = [];
  for (const entry of entries) {
    if (await isElf(join(path, entry))) {
      binaries.push(entry);
    }
  }
  if (binaries.length === 0) {
    throw new BetelgeuzError("artifact.missing", {
      detail: `${path} holds no ELF artifact`,
    });
  }
  if (binaries.length > 1) {
    throw new BetelgeuzError("artifact.ambiguous", {
      detail: `${path} holds ${binaries.length} ELF artifacts: ${binaries.join(", ")}`,
    });
  }
  return join(path, binaries[0]);
}

async function isElf(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    return false;
  }
  const file = await open(path, "r").catch(() => undefined);
  if (file === undefined) {
    return false;
  }
  try {
    const bytes = Buffer.alloc(4);
    const read = await file.read(bytes, 0, 4, 0);
    return read.bytesRead === 4 && bytes.equals(ELF_MAGIC);
  } finally {
    await file.close();
  }
}
