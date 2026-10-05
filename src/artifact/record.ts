/**
 * Reading a host-side artifact into the record the deploy pipeline consumes.
 *
 * The hash is streamed rather than read in one piece: an artifact is as large
 * as the target can hold, and the transport uploads it from a stream for the
 * same reason. Nothing here needs a VS Code host.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { BetelgeuzError } from "../errors";
import type { ArtifactRecord } from "../protocol";

export async function readArtifactRecord(
  path: string,
  targetName: string
): Promise<ArtifactRecord> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new BetelgeuzError("artifact.missing", {
        detail: `${path} must point to a regular file`,
      });
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      hash.update(chunk);
    }
    return { contentHash: hash.digest("hex"), path, size: info.size, targetName };
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      throw error;
    }
    throw new BetelgeuzError("artifact.missing", { cause: error });
  }
}

/**
 * Verifies the host file behind an artifact record still matches it, so a
 * deploy reads the bytes the handoff described rather than whatever the path
 * holds now. Returns the verified path and size for the upload stream.
 */
export async function verifyArtifactFile(
  artifact: ArtifactRecord
): Promise<{ path: string; size: number }> {
  try {
    const info = await stat(artifact.path);
    if (!info.isFile() || info.size !== artifact.size) {
      throw new BetelgeuzError("artifact.missing", {
        detail: "the artifact path or size no longer matches the build record",
      });
    }
    return { path: artifact.path, size: info.size };
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      throw error;
    }
    throw new BetelgeuzError("artifact.missing", { cause: error });
  }
}
