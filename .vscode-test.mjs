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
  // Hide the user's CMake Tools kits: with a single kit available the extension
  // selects it without a prompt, which a headless instance cannot show.
  XDG_DATA_HOME: here(".vscode-test/xdg-data"),
};

export default defineConfig({
  files: "out-test/**/*.test.js",
  extensionDevelopmentPath: here("."),
  workspaceFolder: here("test/fixtures/workspace"),
  env: board,
  // A dedicated profile and extension folder: the command-line test mode
  // refuses to run alongside another Code instance sharing the default ones.
  launchArgs: [
    `--user-data-dir=${here(".vscode-test/user-data")}`,
    `--extensions-dir=${here(".vscode-test/extensions")}`,
    "--disable-gpu",
    "--disable-workspace-trust",
  ],
  // Only for the CMake-source run: the extension whose build directory the
  // artifact is resolved through.
  ...(process.env.BETELGEUZ_TEST_CMAKE === "1"
    ? { installExtensions: ["ms-vscode.cmake-tools"] }
    : {}),
});
