/**
 * CMake Tools adapter.
 *
 * The public API reports the build directory and the target names, but not
 * where a target's output landed, so this adapter hands the build directory to
 * the File API reader and selects the configured target from what it found. The
 * API surface consumed here is declared locally rather than pulled from the
 * extension's typings package: the members differ between releases and the
 * extension reaches its own API only after it has scanned for kits, so a change
 * or a slow start surfaces as an explicit diagnostic instead of a type error.
 *
 * When CMake Tools is absent the plan's fallback carries resolution: the File
 * API codemodel under the workspace's build directory (the `cmake.buildDirectory`
 * setting, or the conventional `build/`) names the same targets and artifacts.
 */
import * as vscode from "vscode";
import { join } from "node:path";

import { BetelgeuzError, isBetelgeuzError } from "../errors";
import {
  deployableTargets,
  readCmakeTargets,
  selectCmakeArtifact,
  type CmakeTarget,
} from "../artifact/cmake";
import { readArtifactRecord } from "../artifact/record";
import type { ArtifactRecord } from "../protocol";

const CMAKE_TOOLS_ID = "ms-vscode.cmake-tools";
/** CMake Tools reaches its API after its kit scan, and only then owns a project;
 * neither is instant, and both are waited for rather than guessed at. */
const API_WAIT_MS = 10_000;
const PROJECT_WAIT_MS = 20_000;
const POLL_MS = 250;

/** The members of CMake Tools' API that Betelgeuz consumes. */
interface CmakeToolsApi {
  getBuildDirectory?(): Promise<string | undefined>;
  /** Present since 1.24; takes the folder the project belongs to. */
  getProjectForUri?(uri: vscode.Uri): Promise<CmakeProject | undefined> | CmakeProject | undefined;
  getProject?(): Promise<CmakeProject | undefined> | CmakeProject | undefined;
}

interface CmakeProject {
  buildDirectory?(): Promise<string | null | undefined>;
}

/** Recent releases activate to an object holding `getApi(version)`. */
type CmakeToolsExports = CmakeToolsApi & {
  getApi?: () => Promise<CmakeToolsApi> | CmakeToolsApi;
};

/** Reads the configured target's artifact through CMake Tools. Without the
 *  extension — or when it never exposes its API — the plan's fallback applies:
 *  the File API codemodel under the workspace's build directory is the
 *  remaining source (plan §6, §9). */
export async function readCmakeArtifact(
  folder: vscode.WorkspaceFolder,
  localTarget: string | undefined
): Promise<ArtifactRecord> {
  try {
    return await viaCmakeToolsApi(folder, localTarget);
  } catch (error) {
    if (!isBetelgeuzError(error) || error.code !== "artifact.cmake-unavailable") {
      throw error;
    }
    const targets = await readCmakeTargets(fallbackBuildDirectory(folder));
    const path = selectCmakeArtifact(targets, localTarget);
    return await readArtifactRecord(path, targetNameFor(targets, path));
  }
}

/** The executable targets a workspace can choose between. Falls back exactly
 *  like a deploy does when CMake Tools cannot answer. */
export async function listCmakeTargets(
  folder: vscode.WorkspaceFolder
): Promise<Array<string>> {
  let buildDirectory: string;
  try {
    buildDirectory = await buildDirectoryOf(await cmakeApi(), folder);
  } catch (error) {
    if (!isBetelgeuzError(error) || error.code !== "artifact.cmake-unavailable") {
      throw error;
    }
    buildDirectory = fallbackBuildDirectory(folder);
  }
  return deployableTargets(await readCmakeTargets(buildDirectory)).map(
    (target) => target.name
  );
}

async function viaCmakeToolsApi(
  folder: vscode.WorkspaceFolder,
  localTarget: string | undefined
): Promise<ArtifactRecord> {
  const api = await cmakeApi();
  const targets = await readCmakeTargets(await buildDirectoryOf(api, folder));
  const path = selectCmakeArtifact(targets, localTarget);
  return await readArtifactRecord(path, targetNameFor(targets, path));
}

/**
 * The build directory when CMake Tools is not there to report one: the
 * workspace's `cmake.buildDirectory` setting if the user set one, otherwise
 * the conventional `build/` under the workspace folder. Only
 * `${workspaceFolder}` is expanded; the other CMake Tools substitutions name
 * state (build type, variant) an absent extension does not have.
 */
function fallbackBuildDirectory(folder: vscode.WorkspaceFolder): string {
  const configured = vscode.workspace
    .getConfiguration("cmake", folder)
    .get<string | undefined>("buildDirectory");
  if (configured === undefined || configured.trim() === "") {
    return join(folder.uri.fsPath, "build");
  }
  return configured.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
}

function targetNameFor(targets: ReadonlyArray<CmakeTarget>, artifact: string): string {
  const owner = targets.find((target) => target.artifacts.includes(artifact));
  return owner?.name ?? "artifact";
}

async function cmakeApi(): Promise<CmakeToolsApi> {
  const extension = vscode.extensions.getExtension<CmakeToolsExports>(CMAKE_TOOLS_ID);
  if (extension === undefined) {
    throw new BetelgeuzError("artifact.cmake-unavailable", {
      detail: `${CMAKE_TOOLS_ID} is not installed`,
    });
  }
  const exports = await activate(extension);
  const read = async (): Promise<CmakeToolsApi | undefined> => {
    try {
      const api = typeof exports.getApi === "function" ? await exports.getApi() : exports;
      return typeof api?.getBuildDirectory === "function" ||
        typeof api?.getProject === "function"
        ? api
        : undefined;
    } catch {
      // The extension is still starting up; its API is not there yet.
      return undefined;
    }
  };

  const deadline = Date.now() + API_WAIT_MS;
  for (;;) {
    const api = await read();
    if (api !== undefined) {
      return api;
    }
    if (Date.now() >= deadline) {
      throw new BetelgeuzError("artifact.cmake-unavailable", {
        detail: `${CMAKE_TOOLS_ID} did not expose its API within ${API_WAIT_MS} ms`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function activate(extension: vscode.Extension<CmakeToolsExports>): Promise<CmakeToolsExports> {
  try {
    return await extension.activate();
  } catch (error) {
    throw new BetelgeuzError("artifact.cmake-unavailable", {
      detail: `${CMAKE_TOOLS_ID} could not be activated`,
      cause: error,
    });
  }
}

async function buildDirectoryOf(
  api: CmakeToolsApi,
  folder: vscode.WorkspaceFolder
): Promise<string> {
  const deadline = Date.now() + PROJECT_WAIT_MS;
  for (;;) {
    const directory = (await api.getBuildDirectory?.()) ??
      (await (await projectFor(api, folder))?.buildDirectory?.());
    if (directory !== undefined && directory !== null && directory.trim() !== "") {
      return directory;
    }
    if (Date.now() >= deadline) {
      throw new BetelgeuzError("artifact.missing", {
        detail: `CMake Tools reported no build directory for this workspace within ${PROJECT_WAIT_MS} ms`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * The project object for this workspace. `getProjectForUri` is the member
 * 1.24 exposes; a bare `getProject` on a release that expects a URI throws, so
 * it is only used when the Uri member is absent.
 */
async function projectFor(
  api: CmakeToolsApi,
  folder: vscode.WorkspaceFolder
): Promise<CmakeProject | undefined> {
  if (api.getProjectForUri !== undefined) {
    return await api.getProjectForUri(folder.uri);
  }
  return await api.getProject?.();
}
