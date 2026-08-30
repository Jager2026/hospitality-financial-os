#!/usr/bin/env node
// @ts-check
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
const { evaluate, AuditUnavailableError } = require("./audit-evaluate");

/** @type {Record<string, string>} */
const IGNORED_ADVISORIES = {};

// Generous relative to a healthy run (seconds), deliberately short relative to a CI job. The point
// is not to be strict, it is to guarantee this gate always reaches an answer — pass, fail, or an
// explicit "could not check" — rather than occupying a runner indefinitely.
const AUDIT_TIMEOUT_MS = 120_000;

/**
 * Three outcomes, and the third is the reason this function exists in this shape.
 *
 * `pnpm audit` exits non-zero the moment it finds an advisory, so on the normal "found something"
 * path the JSON body arrives on the error object's `stdout` rather than as a clean return. But the
 * command also exits non-zero when it could not run at all — pnpm missing from PATH, registry
 * unreachable — and then `stdout` is the EMPTY STRING.
 *
 * The previous `err.stdout ?? "{}"` did not distinguish those. It happened to fail closed, because
 * `??` does not treat `""` as absent, so `JSON.parse("")` threw and killed the run. Safe, but by
 * accident: written as `|| "{}"` — which reads like an obvious cleanup — the empty string becomes
 * `{}`, which is zero advisories, which prints "no advisories found" and exits 0. **A security gate
 * reporting a clean result for a scan that never ran.**
 *
 * So the distinction is now explicit and named. Exit 1 means "checked, and found something".
 * Exit 2 means "could not check" — a different failure that deserves a different message, because
 * the fix is different too. Both fail CI; only one of them means the dependencies are bad.
 *
 * @returns {string} raw JSON from a run that actually produced output
 */
function runAudit() {
  /** @type {string} */
  let stdout;
  /** @type {boolean} */
  let timedOut = false;

  try {
    stdout = execSync("pnpm audit --audit-level=high --json", {
      encoding: "utf8",
      // This command talks to the registry, and a network call with no ceiling is a way for CI to
      // hang rather than fail. It is the same class as the distinction above: a gate that never
      // answers reports nothing and looks, from the outside, exactly like one still working — and
      // a stuck workflow gives no reason for being stuck. Not hypothetical: this exact call was
      // observed hanging for twenty hours when run without a ceiling.
      timeout: AUDIT_TIMEOUT_MS,
    });
  } catch (err) {
    const e = /** @type {{ stdout?: unknown; signal?: unknown; code?: unknown }} */ (err);
    const captured = e.stdout;
    stdout = typeof captured === "string" ? captured : "";
    // Node reports a `timeout` kill as the signal it used (SIGTERM by default) rather than as a
    // distinct error code, so this is how a timeout is actually recognised.
    timedOut = e.signal === "SIGTERM" || e.code === "ETIMEDOUT";
  }

  if (timedOut) {
    unavailable(
      `\`pnpm audit\` did not finish within ${AUDIT_TIMEOUT_MS / 1000}s and was terminated.`,
      "Usually the registry being slow or unreachable. The audit did not complete, so its result",
      "is unknown — which is not the same as finding no vulnerabilities.",
    );
  }

  if (stdout.trim() === "") {
    unavailable(
      "`pnpm audit` produced no output at all.",
      "The audit did not run — this is NOT the same as finding no vulnerabilities.",
    );
  }

  return stdout;
}

/**
 * @param {...string} lines
 * @returns {never}
 */
function unavailable(...lines) {
  console.error("\n  Dependency audit could not be completed.\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error(
    "\n  Failing the build deliberately: a gate that cannot run its check must not report success.\n",
  );
  process.exit(2);
}

const raw = runAudit();

/** @type {unknown} */
let report;
try {
  report = JSON.parse(raw);
} catch (err) {
  unavailable(
    "`pnpm audit` produced output that is not valid JSON.",
    `Parser said: ${err instanceof Error ? err.message : String(err)}`,
    `First 200 characters: ${raw.slice(0, 200)}`,
  );
}

/** @type {{ unignored: any[]; ignoredFound: any[] }} */
let result;
try {
  result = evaluate(report, IGNORED_ADVISORIES);
} catch (err) {
  if (err instanceof AuditUnavailableError) {
    unavailable(
      "`pnpm audit` returned JSON this gate does not recognise.",
      err.message,
      "If pnpm changed its output format, this script must be updated — not bypassed.",
    );
  }
  throw err;
}

if (result.unignored.length > 0) {
  console.error(
    `${result.unignored.length} high/critical advisory(ies) not covered by an explicit ignore:`,
  );
  for (const a of result.unignored) {
    console.error(`  [${a.severity}] ${a.github_advisory_id} — ${a.title} (${a.module_name})`);
  }
  process.exit(1);
}

if (result.ignoredFound.length > 0) {
  console.log(
    `${result.ignoredFound.length} high/critical advisory(ies) present but explicitly ignored:`,
  );
  for (const a of result.ignoredFound) {
    console.log(
      `  [${a.severity}] ${a.github_advisory_id} — ${IGNORED_ADVISORIES[a.github_advisory_id]}`,
    );
  }
} else {
  console.log("No high/critical advisories found.");
}
