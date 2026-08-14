import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts on purpose: same swc plugin (identical reasoning — Test.
// createTestingModule()'s real DI needs decorator metadata esbuild never emits), same globalSetup
// (Currency/Role/Permission fixtures), but a DIFFERENT `include` — test/load files never match
// vitest.config.ts's own `src/**/*.spec.ts` glob, so a routine `pnpm test` never picks them up.
// This file exists only so `pnpm run test:load` has a config where they DO match.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/load/**/*.load.spec.ts"],
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["./test/global-setup.ts"],
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2021",
        keepClassNames: true,
      },
      module: { type: "es6" },
    }),
  ],
});
