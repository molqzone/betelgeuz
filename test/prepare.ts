/**
 * Prepares the fixture workspace for one end-to-end run: the artifact the
 * workspace's settings reference, and the credentials the stubs answer with.
 * Nothing is written into the repository — the artifact is gitignored and the
 * credentials only ever live in this process's environment.
 */
import { copyFile, chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A run starts from a clean profile: no enrolled host key or stored credential
 * from an earlier run, so each run exercises the same path. */
const userData = join(__dirname, "..", ".vscode-test", "user-data");

const workspace = join(__dirname, "fixtures", "workspace");
const artifact = join(workspace, "artifact");
const settings = join(workspace, ".vscode", "settings.json");

const {
  BETELGEUZ_TEST_ARTIFACT,
  BETELGEUZ_TEST_CMAKE,
  BETELGEUZ_TEST_CREDENTIAL_REF,
  BETELGEUZ_TEST_HOST,
  BETELGEUZ_TEST_KEY,
  BETELGEUZ_TEST_PASSWORD,
  BETELGEUZ_TEST_PORT,
  BETELGEUZ_TEST_REMOTE_PATH,
  BETELGEUZ_TEST_USER,
} = process.env;

const PORT = BETELGEUZ_TEST_PORT ?? "22";
const USER = BETELGEUZ_TEST_USER ?? "root";
const CREDENTIAL = BETELGEUZ_TEST_CREDENTIAL_REF ?? "e2e-board";
const REMOTE_PATH = BETELGEUZ_TEST_REMOTE_PATH ?? "/tmp/betelgeuz-e2e/app";
/** `1` deploys the CMake source (a `cmake` CLI build of the fixture project,
 *  resolved through the plan's File API fallback); otherwise the run takes the
 *  manual artifact path. */
const CMAKE = BETELGEUZ_TEST_CMAKE === "1";

async function main(): Promise<void> {
  const required: Record<string, string | undefined> = {
    BETELGEUZ_TEST_HOST: BETELGEUZ_TEST_HOST,
    ...(CMAKE ? {} : { BETELGEUZ_TEST_ARTIFACT: BETELGEUZ_TEST_ARTIFACT }),
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === "") {
      throw new Error(
        CMAKE
          ? `${name} is required: point the run at a board`
          : `${name} is required: point the run at a board and an artifact`
      );
    }
  }
  if (!BETELGEUZ_TEST_PASSWORD && !BETELGEUZ_TEST_KEY) {
    throw new Error(
      "BETELGEUZ_TEST_PASSWORD or BETELGEUZ_TEST_KEY is required: " +
      "the credential the stubs answer with (a password, or a private key file path)"
    );
  }

  await mkdir(workspace, { recursive: true });
  await rm(userData, { recursive: true, force: true });
  // `betelgeuz.profiles` is application-scoped, so a fixture workspace cannot
  // declare one; the inline target keys are resource-scoped and carry the same
  // endpoint. They are written here because they come from the environment.
  await writeFile(
    settings,
    `${JSON.stringify(
      CMAKE
        ? {
            "betelgeuz.attach.strategy": "linux.ssh-app",
            "betelgeuz.deploy.source": "cmake",
            "betelgeuz.deploy.localTarget": "bgapp",
            "betelgeuz.deploy.remotePath": REMOTE_PATH,
            "betelgeuz.deploy.fileMode": "0755",
            "betelgeuz.deploy.args": [],
            "betelgeuz.target.credentialRef": CREDENTIAL,
            "betelgeuz.target.host": BETELGEUZ_TEST_HOST,
            "betelgeuz.target.port": Number(PORT),
            "betelgeuz.target.username": USER,
          }
        : {
            "betelgeuz.attach.strategy": "linux.ssh-app",
            "betelgeuz.deploy.source": "manual",
            "betelgeuz.deploy.artifactPath": "artifact",
            "betelgeuz.deploy.remotePath": REMOTE_PATH,
            "betelgeuz.deploy.fileMode": "0755",
            "betelgeuz.deploy.args": [],
            "betelgeuz.target.credentialRef": CREDENTIAL,
            "betelgeuz.target.host": BETELGEUZ_TEST_HOST,
            "betelgeuz.target.port": Number(PORT),
            "betelgeuz.target.username": USER,
          },
      null,
      2
    )}\n`
  );
  console.log(`e2e: workspace settings → ${settings}`);
  if (CMAKE) {
    // The preset names the wrapper via ${sourceDir}, so only the wrapper —
    // an executable script — needs generating. The File API query makes the
    // CLI configure write the codemodel reply the fallback resolution reads;
    // with no registered client, cmake writes no reply at all.
    const queryDirectory = join(workspace, "build", ".cmake", "api", "v1", "query", "client-betelgeuz");
    await mkdir(queryDirectory, { recursive: true });
    await writeFile(
      join(queryDirectory, "query.json"),
      `${JSON.stringify({ requests: [{ kind: "codemodel", version: 2 }] }, null, 2)}\n`
    );
    await writeFile(
      join(workspace, "zig-cc"),
      `#!/bin/sh\n# CMake preset compiler: zig cc as a gcc-compatible riscv64 cross driver.\nexec zig cc -target riscv64-linux-gnu "$@"\n`
    );
    await chmod(join(workspace, "zig-cc"), 0o755);
    console.log("e2e: zig-cc wrapper + File API query written");
  } else {
    await rm(artifact, { force: true });
    await copyFile(BETELGEUZ_TEST_ARTIFACT as string, artifact);
    const info = await stat(artifact);
    console.log(`e2e: artifact ${info.size} bytes; board ${BETELGEUZ_TEST_HOST}`);
    process.env.BETELGEUZ_TEST_EXPECT_SIZE = String(info.size);
  }
}

main().catch((error: unknown) => {
  console.error("e2e prepare failed:", error);
  process.exit(1);
});
