/**
 * The `test` script for a package that has no tests, written so that it cannot report success
 * while doing nothing.
 *
 * **Why this file exists rather than `echo "no tests yet"`.** `pnpm --recursive run test` exits 0
 * when a package's script exits 0, and prints a success line either way — so an `echo` made this
 * package indistinguishable from one with a passing suite. That is the fifth cause of conditional
 * silence recorded in `BLOCK_CLOSURE_117_156_AUDIT.md`: *"nothing to do" reported identically to
 * "did it, and it passed"*. Two sibling packages carrying the same `echo` were deleted rather than
 * fixed; this one was kept, because it has a named consumer, so its script had to stop lying.
 *
 * **What it asserts is the premise, not the code.** Passing means "this package is still empty, so
 * having no tests is correct". The day someone exports a real type, the premise is false and this
 * fails, naming what to do. That is the only moment at which the absence of tests here becomes a
 * gap, and it is the moment nothing else would have reported.
 *
 * No `@ts-check`: this file makes no claim to be typechecked, and `repo-invariants.spec.ts`
 * enforces that a file which *does* claim one is covered by a tsconfig. Adding the claim would
 * mean widening `tsconfig.scripts.json` for eleven lines that run `readFileSync` and compare
 * strings.
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const files = fs.readdirSync(SRC);
const lines =
  files.length === 1 && files[0] === "index.ts"
    ? fs.readFileSync(path.join(SRC, "index.ts"), "utf8").split("\n")
    : [];
const exported = lines.map((line) => line.trim()).filter((line) => line.startsWith("export"));

if (exported.length === 1 && exported[0] === "export {};") {
  console.log(
    "packages/types is still the placeholder: no code, so no tests. " +
      "This script fails the day that stops being true.",
  );
  process.exit(0);
}

console.error(
  "packages/types now holds real code and still has no test suite.\n" +
    "Write one, and replace this script with it.\n" +
    "Do not widen this check instead: a test script that reports success without running " +
    "anything is exactly what it was written to replace.",
);
process.exit(1);
