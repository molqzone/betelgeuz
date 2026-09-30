/**
 * CMake artifact resolution through the File API.
 *
 * CMake Tools exposes the build directory and target names, but not where a
 * target's output landed, so the artifact path comes from the File API reply
 * that CMake Tools itself reads: an index file, a codemodel configuration, and
 * one JSON file per target. Everything here is pure file and JSON work, so it
 * runs without a VS Code host.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { BetelgeuzError } from "../errors";

/** A target as the codemodel describes it, with absolute artifact paths. */
export type CmakeTarget = {
  readonly artifacts: Array<string>;
  readonly name: string;
  readonly nameOnDisk: string;
  readonly type: string;
};

const CODEMODEL_KEY = "codemodel-v2";
const INDEX_PREFIX = "index-";
const EXECUTABLE_TYPE = "EXECUTABLE";

type CodemodelEntry = { jsonFile: string; major: number };
type IndexedEntry = { jsonFile: string; version?: { major?: number } };

/** The index names every reply object; `reply` is the pre-3.23 layout. */
type ReplyIndex = {
  objects?: Array<{ kind?: string; jsonFile?: string; version?: { major?: number } }>;
  reply?: { "codemodel-v2"?: IndexedEntry | Array<IndexedEntry> };
};

type Codemodel = {
  configurations?: Array<{
    name?: string;
    targets?: Array<{ jsonFile?: string; name?: string }>;
  }>;
};

type TargetFile = {
  artifacts?: Array<{ path?: string }>;
  name?: string;
  nameOnDisk?: string;
  type?: string;
};

/** Reads every target the codemodel describes, in codemodel order. */
export async function readCmakeTargets(buildDirectory: string): Promise<Array<CmakeTarget>> {
  const replyDirectory = join(buildDirectory, ".cmake", "api", "v1", "reply");
  const entries = await readdir(replyDirectory).catch((error: unknown) => {
    throw new BetelgeuzError("artifact.missing", {
      detail: `no CMake File API reply under ${replyDirectory}; configure the project first`,
      cause: error,
    });
  });

  const codemodels: Array<CodemodelEntry> = [];
  for (const name of entries.filter((entry) => entry.startsWith(INDEX_PREFIX))) {
    const index = (await readJson(join(replyDirectory, name))) as ReplyIndex;
    for (const entry of index.objects ?? []) {
      if (entry.kind === "codemodel" && typeof entry.jsonFile === "string") {
        codemodels.push({ jsonFile: entry.jsonFile, major: entry.version?.major ?? 0 });
      }
    }
    const legacy = index.reply?.[CODEMODEL_KEY];
    for (const entry of legacy === undefined ? [] : [legacy].flat()) {
      if (typeof entry?.jsonFile === "string") {
        codemodels.push({ jsonFile: entry.jsonFile, major: entry.version?.major ?? 0 });
      }
    }
  }
  if (codemodels.length === 0) {
    throw new BetelgeuzError("artifact.missing", {
      detail: `the CMake File API reply under ${replyDirectory} names no codemodel`,
    });
  }
  // Two replies can coexist after a reconfiguration; the newer major wins.
  const codemodel = codemodels.reduce((newest, candidate) =>
    candidate.major > newest.major ? candidate : newest
  );

  const model = (await readJson(join(replyDirectory, codemodel.jsonFile))) as Codemodel;
  const targets: Array<CmakeTarget> = [];
  for (const configuration of model?.configurations ?? []) {
    for (const entry of configuration.targets ?? []) {
      if (typeof entry.jsonFile !== "string") {
        continue;
      }
      const target = (await readJson(join(replyDirectory, entry.jsonFile))) as TargetFile | null;
      if (target === null) {
        continue;
      }
      targets.push({
        artifacts: (target.artifacts ?? [])
          .map((artifact) => artifact.path ?? "")
          .filter((path) => path !== "")
          .map((path) => resolve(buildDirectory, path)),
        name: target.name ?? "",
        nameOnDisk: target.nameOnDisk ?? "",
        type: target.type ?? "",
      });
    }
  }
  return targets;
}

/** The targets this strategy can deploy: executables with a build product. */
export function deployableTargets(targets: ReadonlyArray<CmakeTarget>): Array<CmakeTarget> {
  return targets.filter(
    (target) => target.type === EXECUTABLE_TYPE && target.nameOnDisk !== ""
  );
}

/**
 * Picks the one artifact a deploy activates. An unset selection is only
 * unambiguous when the project offers a single executable; several candidates
 * report `artifact.ambiguous` so the caller can ask instead of guessing.
 */
export function selectCmakeArtifact(
  targets: ReadonlyArray<CmakeTarget>,
  localTarget: string | undefined
): string {
  const candidates = deployableTargets(targets);
  if (candidates.length === 0) {
    throw new BetelgeuzError("artifact.missing", {
      detail: "the CMake project declares no executable target",
    });
  }
  const selected = localTarget === undefined || localTarget.trim() === ""
    ? candidates.length === 1
      ? candidates[0]
      : undefined
    : candidates.find((target) => target.name === localTarget.trim());
  if (selected === undefined) {
    throw new BetelgeuzError("artifact.ambiguous", {
      detail: localTarget === undefined || localTarget.trim() === ""
        ? `the CMake project declares ${candidates.length} executable targets: ${namesOf(candidates)}`
        : `CMake target \`${localTarget}\` is not one of: ${namesOf(candidates)}`,
    });
  }
  if (selected.artifacts.length !== 1) {
    throw new BetelgeuzError("artifact.ambiguous", {
      detail:
        `CMake target \`${selected.name}\` produces ${selected.artifacts.length} artifacts; ` +
        "the MVP deploys targets with exactly one",
    });
  }
  return selected.artifacts[0];
}

function namesOf(targets: ReadonlyArray<CmakeTarget>): string {
  return targets.map((target) => `\`${target.name}\``).join(", ");
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    throw new BetelgeuzError("artifact.missing", {
      detail: `the CMake File API reply file ${path} could not be read`,
      cause: error,
    });
  });
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new BetelgeuzError("artifact.missing", {
      detail: `the CMake File API reply file ${path} is not valid JSON`,
      cause: error,
    });
  }
}
