/**
 * `npm run gen:errors` — writes `docs/ERRORS.md` from the error catalog.
 * `npm run gen:errors -- --check` verifies without rewriting.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderErrorCatalog } from "../src/errors";

const path = join(process.cwd(), "docs", "ERRORS.md");
const generated = renderErrorCatalog();

if (process.argv.includes("--check")) {
  const current = readFileSync(path, "utf8");
  if (current !== generated) {
    console.error("docs/ERRORS.md is stale; run `npm run gen:errors`");
    process.exit(1);
  }
  console.log("docs/ERRORS.md is current");
} else {
  writeFileSync(path, generated);
  console.log(`wrote ${path}`);
}
