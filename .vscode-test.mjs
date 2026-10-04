import { mkdirSync } from "node:fs";
import { defineConfig } from "@vscode/test-cli";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

/** The board a run targets. Passed through the CLI's own `env` because a
 * launched extension host does not inherit the shell's environment. */
const board = {
  BETELGEUZ_TEST_EXPECT_SIZE: process.env.BETELGEUZ_TEST_EXPECT_SIZE,
  BETELGEUZ_TEST_HOST: process.env.BETELGEUZ_TEST_HOST,
  BETELGEUZ_TEST_PORT: process.env.BETELGEUZ_TEST_PORT,
  BETELGEUZ_TEST_USER: process.env.BETELGEUZ_TEST_USER,
  BETELGEUZ_TEST_PASSWORD: process.env.BETELGEUZ_TEST_PASSWORD,
  // A private key file path, for boards that authorize a key instead of a
  // password; the stubs then answer the credential prompts with key auth.
  BETELGEUZ_TEST_KEY: process.env.BETELGEUZ_TEST_KEY,
  // Selects the session-drop suite (drop.test.ts), whose artifact runs until
  // it is stopped; the ordinary surface suite is not registered for this run.
  BETELGEUZ_TEST_DROP: process.env.BETELGEUZ_TEST_DROP,
  // Selects the CMake-source deploy suite (cmake-source.test.ts), which
  // builds the fixture's target through CMake Tools before deploying.
  BETELGEUZ_TEST_CMAKE: process.env.BETELGEUZ_TEST_CMAKE,
  // A shell that launched from an AppImage can export an LD_LIBRARY_PATH that
  // breaks cmake's own data-dir lookup; an empty value gives the extension
  // host and every child it spawns (cmake among them) a clean search path.
  LD_LIBRARY_PATH: "",
  // Hide the user's CMake Tools kits: with a single kit available the extension
  // selects it without a prompt, which a headless instance cannot show.
  XDG_DATA_HOME: here(".vscode-test/xdg-data"),
};

// The CMake-source run needs CMake Tools to be ABSENT so the plan's File API
// fallback carries resolution; a dedicated empty extension folder guarantees
// that regardless of what earlier runs installed.
const cmakeRun = process.env.BETELGEUZ_TEST_CMAKE === "1";
if (cmakeRun) {
  mkdirSync(here(".vscode-test/extensions-fallback"), { recursive: true });
}

export default defineConfig({
  files: "out-test/**/*.test.js",
  extensionDevelopmentPath: here("."),
  workspaceFolder: here("test/fixtures/workspace"),
  env: board,
  // A dedicated profile and extension folder: the command-line test mode
  // refuses to run alongside another Code instance sharing the default ones.
  launchArgs: [
    `--user-data-dir=${here(".vscode-test/user-data")}`,
    `--extensions-dir=${cmakeRun
      ? here(".vscode-test/extensions-fallback")
      : here(".vscode-test/extensions")}`,
    "--disable-gpu",
    "--disable-workspace-trust",
  ],
  // The CMake-source run (BETELGEUZ_TEST_CMAKE=1) installs nothing: the
  // CMake Tools API needs a preset or kit selection, which a headless
  // instance cannot answer, so that run exercises the plan's File API
  // fallback instead; the API-first path stays with the real-editor run.
});
