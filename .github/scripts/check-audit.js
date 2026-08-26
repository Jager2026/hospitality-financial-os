#!/usr/bin/env node
// Sprint 13 (Deployment follow-up): `pnpm audit --audit-level=high` alone can't ignore specific
// advisories on the pnpm version this project is pinned to (9.12.0) — `audit.ignore` /
// `--ignore <GHSA-id>` were only added in pnpm 10.11+, confirmed by actually running it against
// this exact pnpm version before writing this script, not assumed from the docs. Bumping pnpm
// itself is a separate, real decision (it drives Railway's own package-manager detection, ADR-031)
// — not something to do silently as a side effect of adding an audit gate. This script does the
// per-advisory ignoring in plain Node instead: run `pnpm audit --json`, fail only on a
// high/critical advisory NOT in the explicit ignore list below, so a genuinely new vulnerability
// still fails CI.
//
// Each entry here needs its own real justification, not just "it's noisy" — see the comment next
// to it. Revisit this list whenever `pnpm audit` output changes or the underlying package upgrades.
//
// EMPTY, and that is the point (ADR-037). This list previously carried four entries — all four in
// the vitest 2.1.9 dependency chain, every one justified as dev-only-and-not-exploitable-here.
// They are gone now because the underlying packages were actually upgraded rather than
// permanently excused: vitest 2 -> 3 removed the critical one outright, and `pnpm.overrides`
// pulled vite/glob/nanoid up to their patched versions. An ignore list is a promise to come back,
// not a place to file things forever; keeping it empty is what makes the gate mean something.
// Adding an entry here again should feel like a decision, not a reflex.
const { execSync } = require("node:child_process");

const IGNORED_ADVISORIES = {};

function runAudit() {
  try {
    // Exits non-zero the moment any advisory meets --audit-level, so stdout is captured via the
    // error object rather than a clean return — the JSON body is what matters, not the exit code.
    return execSync("pnpm audit --audit-level=high --json", { encoding: "utf8" });
  } catch (err) {
    return err.stdout ?? "{}";
  }
}

const raw = runAudit();
const report = JSON.parse(raw);
const advisories = Object.values(report.advisories ?? {});

const unignored = advisories.filter(
  (a) => ["high", "critical"].includes(a.severity) && !(a.github_advisory_id in IGNORED_ADVISORIES),
);

if (unignored.length > 0) {
  console.error(
    `${unignored.length} high/critical advisory(ies) not covered by an explicit ignore:`,
  );
  for (const a of unignored) {
    console.error(`  [${a.severity}] ${a.github_advisory_id} — ${a.title} (${a.module_name})`);
  }
  process.exit(1);
}

const ignoredFound = advisories.filter(
  (a) => ["high", "critical"].includes(a.severity) && a.github_advisory_id in IGNORED_ADVISORIES,
);
if (ignoredFound.length > 0) {
  console.log(`${ignoredFound.length} high/critical advisory(ies) present but explicitly ignored:`);
  for (const a of ignoredFound) {
    console.log(
      `  [${a.severity}] ${a.github_advisory_id} — ${IGNORED_ADVISORIES[a.github_advisory_id]}`,
    );
  }
} else {
  console.log("No high/critical advisories found.");
}
