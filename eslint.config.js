import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      ".npm/",
      ".cache/",
      "*.sdPlugin/bin/",
      // Built from src/inspector/page (rollup); the sources are linted.
      "*.sdPlugin/ui/connection.js",
      "release/",
      // Linked git worktrees of this repository live here; each is checked on its own.
      "worktrees/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // node:test registers suites and tests synchronously; the runner tracks their promises.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["describe", "it", "before", "after"] },
          ],
        },
      ],
    },
  },
  {
    files: ["eslint.config.js", "rollup.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Plain JavaScript for the same reason as rollup.config.mjs (the rollup
    // plugins' default exports do not typecheck under NodeNext).
    files: ["scripts/plugin/third-party-notices.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    // The Property Inspector page script runs in Stream Deck's browser
    // view; it is plain JavaScript outside the TypeScript project.
    files: ["*.sdPlugin/ui/**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      sourceType: "script",
      globals: {
        document: "readonly",
        window: "readonly",
        WebSocket: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
