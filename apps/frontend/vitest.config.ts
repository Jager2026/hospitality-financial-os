import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `scripts/` is included alongside `src/` because the build guard lives there and is now
    // tested. Its spec sits next to the script it exercises rather than being relocated into
    // `src/` to satisfy a glob — a test that has to move away from its subject is a test nobody
    // finds when they edit the subject.
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx", "scripts/**/*.spec.ts"],
  },
});
