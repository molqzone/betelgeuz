import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BetelgeuzError } from "../errors";
import {
  deployableTargets,
  readCmakeTargets,
  selectCmakeArtifact,
} from "../artifact/cmake";

/** Writes the reply files a configured project leaves behind. */
async function writeReply(
  buildDirectory: string,
  reply: {
    codemodel: unknown;
    index?: unknown;
    targets: Array<{ file: string; json: unknown }>;
  }
): Promise<void> {
  const directory = join(buildDirectory, ".cmake", "api", "v1", "reply");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "index-9f1b.json"),
    JSON.stringify(
      reply.index ?? {
        reply: {
          "codemodel-v2": { jsonFile: "codemodel-v2-9f1b.json", version: { major: 2 } },
        },
      }
    )
  );
  await writeFile(join(directory, "codemodel-v2-9f1b.json"), JSON.stringify(reply.codemodel));
  for (const target of reply.targets) {
    await writeFile(join(directory, target.file), JSON.stringify(target.json));
  }
}

function codemodel(targets: Array<{ jsonFile: string; name: string }>): unknown {
  return { configurations: [{ name: "Debug", directory: ".", targets, projects: [] }] };
}

describe("CMake File API reading", () => {
  it("resolves the artifact of the configured target", async () => {
    const build = await mkdtemp(join(tmpdir(), "betelgeuz-cmake-"));
    await writeReply(build, {
      codemodel: codemodel([
        { jsonFile: "target-app.json", name: "my_app" },
        { jsonFile: "target-lib.json", name: "my_lib" },
      ]),
      targets: [
        {
          file: "target-app.json",
          json: {
            name: "my_app",
            nameOnDisk: "my_app",
            type: "EXECUTABLE",
            artifacts: [{ path: "my_app" }],
          },
        },
        {
          file: "target-lib.json",
          json: {
            name: "my_lib",
            nameOnDisk: "libmy_lib.a",
            type: "STATIC_LIBRARY",
            artifacts: [{ path: "libmy_lib.a" }],
          },
        },
      ],
    });

    const targets = await readCmakeTargets(build);
    expect(deployableTargets(targets).map((target) => target.name)).toEqual(["my_app"]);
    expect(selectCmakeArtifact(targets, "my_app")).toBe(join(build, "my_app"));
  });

  it("reports a project with several executables instead of guessing", async () => {
    const build = await mkdtemp(join(tmpdir(), "betelgeuz-cmake-"));
    await writeReply(build, {
      codemodel: codemodel([
        { jsonFile: "target-a.json", name: "app_a" },
        { jsonFile: "target-b.json", name: "app_b" },
      ]),
      targets: [
        {
          file: "target-a.json",
          json: {
            name: "app_a",
            nameOnDisk: "app_a",
            type: "EXECUTABLE",
            artifacts: [{ path: "app_a" }],
          },
        },
        {
          file: "target-b.json",
          json: {
            name: "app_b",
            nameOnDisk: "app_b",
            type: "EXECUTABLE",
            artifacts: [{ path: "app_b" }],
          },
        },
      ],
    });

    const targets = await readCmakeTargets(build);
    expect(codeOf(() => selectCmakeArtifact(targets, undefined))).toBe("artifact.ambiguous");
    expect(selectCmakeArtifact(targets, "app_b")).toBe(join(build, "app_b"));
  });

  it("refuses a target that produces more than one artifact", async () => {
    const build = await mkdtemp(join(tmpdir(), "betelgeuz-cmake-"));
    await writeReply(build, {
      codemodel: codemodel([{ jsonFile: "target-multi.json", name: "app" }]),
      targets: [
        {
          file: "target-multi.json",
          json: {
            name: "app",
            nameOnDisk: "app.elf",
            type: "EXECUTABLE",
            artifacts: [{ path: "app.elf" }, { path: "app.bin" }],
          },
        },
      ],
    });

    const targets = await readCmakeTargets(build);
    expect(() => selectCmakeArtifact(targets, "app")).toThrow(BetelgeuzError);
    expect(detailOf(() => selectCmakeArtifact(targets, "app"))).toContain("2 artifacts");
  });

  it("names the targets a configured selection cannot match", async () => {
    const build = await mkdtemp(join(tmpdir(), "betelgeuz-cmake-"));
    await writeReply(build, {
      codemodel: codemodel([{ jsonFile: "target-app.json", name: "my_app" }]),
      targets: [
        {
          file: "target-app.json",
          json: {
            name: "my_app",
            nameOnDisk: "my_app",
            type: "EXECUTABLE",
            artifacts: [{ path: "my_app" }],
          },
        },
      ],
    });

    const targets = await readCmakeTargets(build);
    expect(codeOf(() => selectCmakeArtifact(targets, "other_app"))).toBe("artifact.ambiguous");
    expect(deployableTargets(targets)).toHaveLength(1);
  });

  it("reads the pre-3.23 reply layout", async () => {
    const build = await mkdtemp(join(tmpdir(), "betelgeuz-cmake-"));
    await writeReply(build, {
      index: {
        reply: {
          "codemodel-v2": {
            jsonFile: "codemodel-v2-9f1b.json",
            version: { major: 2, minor: 6 },
          },
        },
      },
      codemodel: codemodel([{ jsonFile: "target-app.json", name: "my_app" }]),
      targets: [
        {
          file: "target-app.json",
          json: {
            name: "my_app",
            nameOnDisk: "my_app",
            type: "EXECUTABLE",
            artifacts: [{ path: "my_app" }],
          },
        },
      ],
    });

    const targets = await readCmakeTargets(build);
    expect(selectCmakeArtifact(targets, "my_app")).toBe(join(build, "my_app"));
  });

  it("reports a project that was never configured", async () => {
    const build = await mkdtemp(join(tmpdir(), "betelgeuz-cmake-"));
    await expect(readCmakeTargets(build)).rejects.toMatchObject({ code: "artifact.missing" });

    await writeReply(build, {
      codemodel: codemodel([]),
      targets: [],
    });
    expect(await readCmakeTargets(build)).toEqual([]);
  });
});

function detailOf(run: () => unknown): string {
  return errorOf(run).detail ?? "";
}

function errorOf(run: () => unknown): BetelgeuzError {
  try {
    run();
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a BetelgeuzError");
}

function codeOf(run: () => unknown): string {
  return errorOf(run).code;
}

