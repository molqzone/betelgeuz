import { defineConfig } from "@vscode/test-cli";
import { fileURLToPath } from "node:url";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

/** The board a run targets. Passed through the CLI's own `env` because a
 * launched extension host does not inherit the shell's environment. */
const board = {
  BETELGEUZ_TEST_HOST: process.env.BETELGEUZ_TEST_HOST,
  BETELGEUZ_TEST_PORT: process.env.BETELGEUZ_TEST_PORT,
  BETELGEUZ_TEST_USER: process.env.BETELGEUZ_TEST_USER,
  BETELGEUZ_TEST_PASSWORD: process.env.BETELGEUZ_TEST_PASSWORD,
};

export default defineConfig({
  files: "out-test/**/*.test.js",
  extensionDevelopmentPath: here("."),
  workspaceFolder: here("test/fixtures/workspace"),
  env: board,
});
