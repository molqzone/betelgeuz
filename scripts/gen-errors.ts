/**
 * `npm run gen:errors` — writes `docs/ERRORS.md` from the error catalog.
 * `npm run gen:errors -- --check` verifies without rewriting.
 *
 * The catalog is composed from the common core definitions and each strategy's
 * own definitions, so the script imports both owners and passes the strategy
 * catalogs in registry order.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderErrorCatalog } from "../src/errors";
import { RPROC_ERRORS } from "../src/strategies/remoteproc";

const path = join(process.cwd(), "docs", "ERRORS.md");
const generated = renderErrorCatalog(RPROC_ERRORS);

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
