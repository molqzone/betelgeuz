/**
 * CMake Tools adapter.
 *
 * The public API reports the build directory and the target names, but not
 * where a target's output landed, so this adapter hands the build directory to
 * the File API reader and selects the configured target from what it found. The
 * API surface consumed here is declared locally rather than pulled from the
 * extension's typings package: it is a handful of members, and a change in the
 * extension surfaces as an explicit "CMake Tools is unavailable" diagnostic
 * rather than as a compile error.
 */
import * as vscode from "vscode";

import { BetelgeuzError } from "../errors";
import {
  deployableTargets,
  readCmakeTargets,
  selectCmakeArtifact,
  type CmakeTarget,
} from "../artifact/cmake";
import { readArtifactRecord } from "../artifact/record";
import type { ArtifactRecord } from "../protocol";

const CMAKE_TOOLS_ID = "ms-vscode.cmake-tools";

/** The members of CMake Tools' API that Betelgeuz consumes. */
interface CmakeToolsApi {
  getBuildDirectory?(): Promise<string | undefined>;
  listBuildTargets?(): Promise<Array<string> | undefined>;
}

/** Reads the configured target's artifact through CMake Tools. */
export async function readCmakeArtifact(localTarget: string | undefined): Promise<ArtifactRecord> {
  const buildDirectory = await cmakeBuildDirectory();
  const targets = await readCmakeTargets(buildDirectory);
  const path = selectCmakeArtifact(targets, localTarget);
  return await readArtifactRecord(path, targetNameFor(targets, path));
}

/** The executable targets a workspace can choose between. */
export async function listCmakeTargets(): Promise<Array<string>> {
  const buildDirectory = await cmakeBuildDirectory();
  return deployableTargets(await readCmakeTargets(buildDirectory)).map((target) => target.name);
}

function targetNameFor(targets: ReadonlyArray<CmakeTarget>, artifact: string): string {
  const owner = targets.find((target) => target.artifacts.includes(artifact));
  return owner?.name ?? "artifact";
}

async function activate(
  extension: vscode.Extension<CmakeToolsApi>
): Promise<CmakeToolsApi> {
  try {
    return await extension.activate();
  } catch (error) {
    throw new BetelgeuzError("artifact.cmake-unavailable", {
      detail: `${CMAKE_TOOLS_ID} could not be activated`,
      cause: error,
    });
  }
}

async function buildDirectoryOf(api: CmakeToolsApi): Promise<string> {
  try {
    const buildDirectory = await api.getBuildDirectory?.();
    if (buildDirectory === undefined || buildDirectory.trim() === "") {
      throw new BetelgeuzError("artifact.missing", {
        detail: "configure the CMake project before deploying",
      });
    }
    return buildDirectory;
  } catch (error) {
    if (error instanceof BetelgeuzError) {
      throw error;
    }
    throw new BetelgeuzError("artifact.cmake-unavailable", {
      detail: `${CMAKE_TOOLS_ID} did not report a build directory`,
      cause: error,
    });
  }
}

async function cmakeBuildDirectory(): Promise<string> {
  const extension = vscode.extensions.getExtension<CmakeToolsApi>(CMAKE_TOOLS_ID);
  if (extension === undefined) {
    throw new BetelgeuzError("artifact.cmake-unavailable", {
      detail: `${CMAKE_TOOLS_ID} is not installed`,
    });
  }
  const api = await activate(extension);
  if (api?.getBuildDirectory === undefined) {
    throw new BetelgeuzError("artifact.cmake-unavailable", {
      detail: `${CMAKE_TOOLS_ID} exposes no build directory in this version`,
    });
  }
  const buildDirectory = await buildDirectoryOf(api);
  if (buildDirectory === undefined || buildDirectory.trim() === "") {
    throw new BetelgeuzError("artifact.missing", {
      detail: "configure the CMake project before deploying",
    });
  }
  return buildDirectory;
}
