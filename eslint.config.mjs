import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Standalone Node utility scripts are not part of the TS program; they are
    // covered by `node --check` semantics + the secret/license gates instead.
    // `ui-schema/` is the sibling UI repo that CI checks out into the workspace
    // for integration tests — it is not our code and must not be linted here.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scripts/*.mjs",
      "ui-schema/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Fail-closed philosophy: no silent `any`, no unchecked escape hatches.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Tests and fakes may use a looser surface (unsafe access to fake internals).
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
    },
  },
  {
    // The worker/CLI entrypoints legitimately write to stdout/stderr.
    files: ["src/entrypoints/**/*.ts", "src/observability/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
