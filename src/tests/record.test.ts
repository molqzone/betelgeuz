import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readArtifactRecord } from "../artifact/record";

describe("artifact record reading", () => {
  it("hashes and measures a host-side file without buffering it whole", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-record-"));
    const path = join(directory, "app");
    const bytes = Buffer.from("betelgeuz artifact payload\n");
    await writeFile(path, bytes);

    const record = await readArtifactRecord(path, "my_app");

    expect(record.path).toBe(path);
    expect(record.targetName).toBe("my_app");
    expect(record.size).toBe(bytes.length);
    expect(record.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("reports a path that is not a regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-record-"));
    const nested = join(directory, "nested");
    await mkdir(nested);

    await expect(readArtifactRecord(nested, "my_app")).rejects.toMatchObject({
      code: "artifact.missing",
    });
  });

  it("reports a path that does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "betelgeuz-record-"));
    await expect(
      readArtifactRecord(join(directory, "absent"), "my_app")
    ).rejects.toMatchObject({ code: "artifact.missing" });
  });
});
