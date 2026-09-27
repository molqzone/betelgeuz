// T1's referee: no floating promises, no misused promises.
// The boundary rules (Surface Law, S2) are enforced by src/boundaries.test.ts.
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    ignores: ["out/**", "node_modules/**", "scripts/**", "eslint.config.mjs"],
  }
);
