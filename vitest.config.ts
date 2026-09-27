import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only hand-written sources are tests; `out/` holds tsc's compiled
    // duplicates and must never be collected.
    include: ["src/**/*.test.ts"],
    exclude: ["out/**", "node_modules/**", "scripts/**"],
  },
});
