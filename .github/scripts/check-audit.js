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
//
// ── `pnpm.overrides` IS A FLOOR, NOT A CEILING — and the difference is invisible ──────────────
//
// An override in the root `package.json` states which versions are ACCEPTABLE. The lockfile states
// which one is INSTALLED. `pnpm install` never re-resolves an entry that still satisfies its
// range, so an override written before a patch existed keeps the old resolution indefinitely while
// the line reads as though the package were handled. It is the shape CLAUDE.md already names: a
// record that looks like a mechanism.
//
// This was not theory. On 2026-09-09 two of them were sitting on vulnerable versions their own
// ranges already permitted them to leave:
//
//     "multer": "^2.2.0"   -> lockfile 2.2.0, while 2.3.0 existed   (3 high, denial of service)
//     "sharp":  "^0.35.0"  -> lockfile 0.35.3, while 0.35.4 existed (1 high, via libheif)
//
// Both were raised to the patched version explicitly, so the line now states the fact it appears
// to state. Three more were stale in the same way without being vulnerable — `postcss` 8.5.25,
// `body-parser` 1.20.6 and `qs` 6.15.3 — and were raised for the same reason: a floor nobody has
// checked is indistinguishable from one that is doing nothing.
//
// ── STATE OF EVERY OVERRIDE, CHECKED 2026-09-09 ──────────────────────────────────────────────
//
// **This is a claim about a moment, and it will go stale** (ADR-078) — which is why it carries a
// date rather than the present tense. On 2026-09-09 all thirteen overrides installed the newest
// version their own range allows, and `pnpm audit` reported no high or critical advisory. The
// method, so it can be repeated rather than re-invented: for each override, compare the range
// against the version in `pnpm-lock.yaml` AND against the newest published version the range
// already permits. Only the third of those catches this class; the first two always agree.
//
//   multer 2.3.0 · lodash 4.18.1 · postcss 8.5.28 · body-parser 1.20.8 · qs 6.16.0 ·
//   file-type 21.3.4 · sharp 0.35.4 · vite 6.4.3 · glob 10.5.0 · nanoid 3.3.18 ·
//   fast-uri 3.1.7 · js-yaml 4.3.2
//
// **`uuid` is the thirteenth and installs nothing.** `"uuid": "^11.1.1"` has governed no package
// since it was added with the rest of this block in #12: the name appears in `pnpm-lock.yaml`
// exactly once, as the override declaration itself, with no package entry anywhere in the tree.
// It is harmless and it is not nothing — it reads as protection that is not being applied, and if
// a future dependency pulls `uuid` in, the range that then starts governing it is one nobody chose
// for that purpose. Left in place rather than deleted, because removing it is a decision about
// pre-emptive overrides in general and belongs with somebody who wants to make that decision.
//
// **Nothing checks any of the above.** The comparison is three lines of `semver` against the
// lockfile and the registry, and it would fit here or as a gate step; it is not built, so this
// paragraph is a record and not a guarantee.
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
