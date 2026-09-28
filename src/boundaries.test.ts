/**
 * Boundary enforcement — the referee for the Surface Law and S2.
 *
 * The core modules (everything outside the surface allowlist) must not import
 * `vscode`: they stay testable and reviewable on their own. Module-level
 * mutable state is banned everywhere; state lives in explicit owners.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Files and directories allowed to import `vscode` (the surface layer). */
const SURFACE_ALLOWLIST = ["extension.ts", "surface/"];

const CORE_SUFFIXES = /\.(ts)$/;
const TEST_SUFFIX = /\.test\.ts$/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (CORE_SUFFIXES.test(entry.name) && !TEST_SUFFIX.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe("module boundaries", () => {
  const root = join(process.cwd(), "src");
  const files = sourceFiles(root);

  it("only the surface layer imports vscode", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const importsVscode = /from\s+["']vscode["']|require\(["']vscode["']\)/.test(
        source
      );
      const isSurface = SURFACE_ALLOWLIST.some((prefix) =>
        file.replace(/\\/g, "/").includes(`/src/${prefix}`)
      );
      if (importsVscode && !isSurface) {
        expect.fail(`${file} imports vscode but is not in the surface allowlist`);
      }
    }
  });

  it("no module-level mutable state", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (/^(let|var)\s/.test(line)) {
          expect.fail(`${file} has module-level mutable state: ${line.trim()}`);
        }
      }
    }
  });
});
