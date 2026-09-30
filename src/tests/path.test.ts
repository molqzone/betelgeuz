import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveArtifactFile } from "../artifact/path";

const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "betelgeuz-path-"));
}

describe("configured artifact path", () => {
  it("takes a file as it is", async () => {
    const directory = await workspace();
    const path = join(directory, "app");
    await writeFile(path, ELF);

    expect(await resolveArtifactFile(path)).toBe(path);
  });

  it("resolves a directory that holds exactly one ELF", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "board"));
    await writeFile(join(directory, "board", "guidance_light_detector_cli"), ELF);
    await writeFile(join(directory, "board", "compile_commands.json"), "{}");
    await mkdir(join(directory, "board", "obj"));

    expect(await resolveArtifactFile(join(directory, "board"))).toBe(
      join(directory, "board", "guidance_light_detector_cli")
    );
  });

  it("names the candidates instead of picking one", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "board"));
    await writeFile(join(directory, "board", "app.elf"), ELF);
    await writeFile(join(directory, "board", "app.bin"), ELF);

    const failure: { code?: string; detail?: string } = {};
    await resolveArtifactFile(join(directory, "board")).catch((error: unknown) => {
      const e = error as { code?: string; detail?: string };
      failure.code = e.code;
      failure.detail = e.detail;
    });
    expect(failure.code).toBe("artifact.ambiguous");
    expect(failure.detail).toContain("app.bin");
    expect(failure.detail).toContain("app.elf");
  });

  it("reports a directory without an ELF and a path that does not exist", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "empty"));

    await expect(resolveArtifactFile(join(directory, "empty"))).rejects.toMatchObject({
      code: "artifact.missing",
    });
    await expect(resolveArtifactFile(join(directory, "absent"))).rejects.toMatchObject({
      code: "artifact.missing",
    });
  });
});
