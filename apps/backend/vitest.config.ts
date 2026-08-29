import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // test/*.spec.ts (top level only) covers specs that must import from prisma/ or test/, which a
    // spec under src/ cannot do — tsconfig.json pins rootDir to ./src. Deliberately NOT recursive:
    // test/load/ has its own config and its own script (test:load), because those specs fire real
    // concurrent payment load and would flood the shared database that every other spec asserts on.
    include: ["src/**/*.spec.ts", "test/*.spec.ts"],
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["./test/global-setup.ts"],
  },
  plugins: [
    // esbuild (vitest's default TS transform) doesn't emit `design:paramtypes` decorator
    // metadata — only a real `tsc`-style compile does, which is what `nest build` runs but
    // vitest never did. Without this, NestJS's automatic constructor injection in a
    // Test.createTestingModule() silently resolves every parameter to `undefined` instead of
    // throwing, which is exactly what auth-throttle.integration.spec.ts hit. swc's
    // decoratorMetadata option reproduces what tsc emits, closely enough for Nest's DI to work.
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
