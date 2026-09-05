// NO @ts-check here, deliberately, and the reason is resolution rather than syntax.
//
// The marker was present and unread by any compiler from the day it was written: no tsconfig
// included this file. Adding it to tsconfig.scripts.json surfaces what the marker had been
// silently not checking — `@typescript-eslint/parser` publishes its types behind an `exports`
// map that `moduleResolution: "node"` cannot follow, and `eslint-config-prettier` ships none at
// all. Moving this config to `node16` or `bundler` would change module resolution for the six
// CommonJS scripts that share it, to typecheck one file that no product code imports.
//
// So the honest half of the choice the repo-invariant offers is taken: stop claiming. The file is
// still exercised on every `pnpm run lint`, which is the check that actually matters for it.
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");
const prettierConfig = require("eslint-config-prettier");

module.exports = [
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/prisma/migrations/**",
      // Next.js-generated, "This file should not be edited" per its own header — Next 15's typed
      // routes feature writes a triple-slash reference into it on every dev/build run
      // (`/// <reference path="./.next/types/routes.d.ts" />`), which @typescript-eslint's
      // triple-slash-reference rule otherwise flags. Ignoring the generated file, not weakening
      // the rule for hand-written code.
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Leading-underscore params/vars are the established convention in this codebase for
      // "required by the interface but intentionally unused" (e.g. NestJS's ParamDecorator
      // factory signature, or a fake test double matching a real method's shape) — matching
      // TypeScript's own noUnusedParameters behavior, which already ignores them. Without this,
      // ESLint and tsc disagree on the same convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  prettierConfig,
];
