// T1's referee: no floating promises, no misused promises.
// The boundary rules (Surface Law, S2) are enforced by src/boundaries.test.ts.
import tseslint from "typescript-eslint";

export default [
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
      // The transport contract mandates Promise-returning methods; synchronous
      // implementations (the fake) legitimately carry no await.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["out/**", "node_modules/**", "scripts/**", "eslint.config.mjs"],
  },
];
