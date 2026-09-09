#!/usr/bin/env node
// @ts-check
/**
 * The gate — one command that runs everything CI runs, in the order CI runs it.
 *
 * **Why this exists, and it is a finding rather than a convenience.** Two of CI's checks —
 * `check-doc-index.js` and `check-audit.js` — were reachable only from the workflow. No script in
 * any `package.json` called them, so "I ran the gate before pushing" was never true and could not
 * be made true: the gate did not exist as a thing anybody could run. It was a list of commands
 * held in a person's head, and a list held in a head is run selectively. That is exactly how a
 * documentation version bump reached CI with the register still naming the old number (#176) —
 * lint, format, typecheck, build and the whole test suite were green locally, and the one check
 * that would have caught it was unrunnable.
 *
 * **The order is the workflow's order, and one part of it is a decision rather than an accident.**
 * The dependency scan runs LAST (Founder decision, 2026-09-04, recorded on `ci.yml`'s own step):
 * it depends on a third party we do not control, and when that endpoint was intermittently dead
 * for hours, a failure there hid whether our own code was green. Everything of ours reports first.
 *
 * **What this deliberately does NOT have: flags.** No `--only`, no `--skip`, no `--fast`. A gate
 * with a way past it becomes the way past it — the same decay `CLAUDE.md` records for allowlists
 * and for guards that most callers have to bypass. The individual scripts still exist
 * (`pnpm run lint`, and so on) for iterating on one thing; this command is the whole thing.
 *
 * **What it cannot mirror, stated so nobody expects it to.** CI runs on a fresh runner with its
 * own Postgres and Redis containers and a database that starts empty. This runs against whatever
 * is on the machine. So a green gate is evidence that the checks pass, not that they pass from
 * nothing — `pnpm run db:reset` is still the answer when a suite failure smells of accumulated
 * rows (`IMPLEMENTATION_PLAN.md`).
 */
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");

/**
 * The one environment variable CI supplies that a developer's machine does not, and it is
 * behavioural rather than cosmetic: `apps/frontend/scripts/check-public-env.mjs` refuses a
 * loopback API URL on every build, and with nothing set the build fails before it starts.
 *
 * The value is the one `ci.yml` uses — the real public API address — deliberately, rather than the
 * `ALLOW_LOOPBACK_API_URL=1` escape hatch. A local build that exercises the escape hatch proves
 * something weaker than the build CI runs, and the point of this command is that they agree.
 *
 * Only set when absent, so a developer with a reason to build against something else keeps it.
 */
if (!process.env.NEXT_PUBLIC_API_URL) {
  process.env.NEXT_PUBLIC_API_URL = "https://api.plaintabs.com";
}

/**
 * Every `run:` step of `.github/workflows/ci.yml`, in order, plus the browser suite from
 * `.github/workflows/e2e.yml`. The names are the workflow's step names, character for character:
 * a step that fails here should be searchable in the Actions log, and if the two lists are ever
 * compared mechanically (ADR-077 records the options), the name is the key that comparison uses.
 *
 * `ci.yml`'s "Compose Stripe and Resend CI placeholders" step is deliberately absent: it invents
 * random credentials for a runner that has no `.env`, writing them to `$GITHUB_ENV`. Locally that
 * file is `apps/backend/.env`, and overwriting a developer's real test keys with random ones is
 * the opposite of faithful.
 *
 * @type {{ name: string, run: string, when?: () => { run: boolean, why: string } }[]}
 */
const STEPS = [
  { name: "Install dependencies", run: "pnpm install --frozen-lockfile" },
  { name: "Generate Prisma Client", run: "pnpm run prisma:generate" },
  { name: "Lint", run: "pnpm run lint" },
  { name: "Format check", run: "pnpm run format" },
  { name: "Documentation index integrity", run: "node .github/scripts/check-doc-index.js" },
  { name: "Validate Prisma schema", run: "pnpm run prisma:validate" },
  { name: "Apply database migrations", run: "pnpm run prisma:migrate:deploy" },
  { name: "Typecheck", run: "pnpm run typecheck" },
  { name: "Test", run: "pnpm run test" },
  { name: "Build", run: "pnpm run build" },
  {
    name: "Run browser end-to-end suite",
    run: "pnpm --filter e2e run test:e2e",
    when: browserSuiteApplies,
  },
  { name: "Dependency vulnerability scan", run: "node .github/scripts/check-audit.js" },
];

/**
 * The browser suite's own condition, mirrored — including the fact that it HAS one.
 *
 * ADR-041: a slow check that runs on everything starts getting worked around, and that reasoning
 * applies at least as strongly to a command a person types before every push. ADR-073 moved the
 * condition out of the workflow trigger and into a job so that a skip is visible rather than
 * silent; the same is true here, which is why a skip prints its reason.
 *
 * **The prefixes are read out of `e2e.yml` rather than copied**, so there is one list rather than
 * two that have to agree. If the line cannot be found, or the diff cannot be computed, the answer
 * is RUN — the same failing-closed rule the workflow's own `decide` step is built on, and for the
 * same reason: a decision step that cannot decide must never be the reason a check went quiet.
 *
 * Wider than CI in one direction, on purpose: uncommitted work counts too. Locally this runs
 * before the commit exists, so a change that has not been committed yet is exactly the change
 * being checked.
 *
 * @returns {{ run: boolean, why: string }}
 */
function browserSuiteApplies() {
  const prefixes = e2ePathPrefixes();
  if (prefixes === null) {
    return { run: true, why: "could not read PATHS out of .github/workflows/e2e.yml" };
  }

  const changed = changedFiles();
  if (changed === null) {
    return { run: true, why: "could not compute the changed files against origin/main" };
  }
  if (changed.length === 0) {
    return { run: true, why: "no change found against origin/main, which is unexpected here" };
  }

  const hit = firstUnderPrefix(changed, prefixes);
  if (hit !== null) return { run: true, why: hit.file + " is under " + hit.prefix };
  return { run: false, why: "nothing changed under: " + prefixes.join(" ") };
}

/**
 * The prefix test itself, separated so that a `false` can be shown to be honest.
 *
 * A negative answer here is indistinguishable, from the outside, from a negative answer produced by
 * a mangled path — which is exactly what happened when `apps/frontend/x` was being read as
 * `pps/frontend/x`. Splitting it out lets a test assert the decision over paths it has verified
 * character for character, rather than over whatever the parser happened to produce.
 *
 * @param {string[]} changed @param {string[]} prefixes
 * @returns {{ file: string, prefix: string } | null}
 */
function firstUnderPrefix(changed, prefixes) {
  for (const prefix of prefixes) {
    const file = changed.find((f) => f.startsWith(prefix));
    if (file !== undefined) return { file, prefix };
  }
  return null;
}

/** @returns {string[] | null} the PATHS list from e2e.yml's decide step, or null if unreadable */
function e2ePathPrefixes() {
  try {
    const yaml = readFileSync(join(ROOT, ".github", "workflows", "e2e.yml"), "utf8");
    const m = /^\s*PATHS="([^"]+)"\s*$/m.exec(yaml);
    if (m === null) return null;
    const parts = m[1].trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

/** @returns {string[] | null} the diff against origin/main, plus anything uncommitted */
function changedFiles() {
  const diff = git(["diff", "--name-only", "origin/main...HEAD"]);
  if (diff === null) return null;
  const dirty = dirtyPaths();
  if (dirty === null) return null;

  const names = diff.split("\n").concat(dirty);
  return names.map((n) => n.replace(/^"|"$/g, "")).filter(Boolean);
}

/**
 * The paths `git status --porcelain` reports, read as the fixed-width format it actually is.
 *
 * **In this format the leading whitespace is DATA.** Each line is `XY path`: `X` is the index
 * status and `Y` the worktree status, and a file modified but not staged is ` M path` — a leading
 * SPACE. That is why this must not be handed output that has been tidied: `String.trim()` removes
 * the leading space of the FIRST line only, after which `slice(3)` eats the first character of
 * that one path.
 *
 * It is not hypothetical and it was not cosmetic. Measured on 2026-09-09 (ADR-077's amendment):
 * an unstaged edit to `apps/frontend/scripts/check-public-env.mjs`, alphabetically first among the
 * changed paths, was read as `pps/frontend/...`, and `browserSuiteApplies()` answered *"nothing
 * changed under: apps/frontend/ …"*. The browser suite was skipped for a change that requires it —
 * silently, and in the direction of running less.
 *
 * **The fix is at the source rather than at this call site**: `git()` no longer normalises what it
 * returns, because a helper that tidies output is a hazard wherever whitespace carries meaning,
 * and `scripts/preflight-deploy.js` had already grown the same pairing on the same command.
 *
 * @param {string} [cwd] the repository to read; the parameter exists so this can be exercised
 *   against a purpose-built repository in a test, which is the only way to cover the seam where
 *   the defect actually lived — a parser fed hand-written strings would have passed throughout.
 * @returns {string[] | null}
 */
function dirtyPaths(cwd = ROOT) {
  const out = git(["status", "--porcelain"], cwd);
  if (out === null) return null;

  const paths = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    // `XY path`, and for a rename `XY old -> new`. The destination is the file that exists now.
    const path = line.slice(3);
    if (path === "") continue;
    const arrow = path.lastIndexOf(" -> ");
    paths.push(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return paths;
}

/**
 * Raw stdout, deliberately — see `dirtyPaths`. Callers that want it tidied say so themselves.
 *
 * @param {string[]} args @param {string} [cwd] @returns {string | null}
 */
function git(args, cwd = ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout;
}

/** @param {string} text */
function heading(text) {
  console.log("\n" + text + "");
}

function main() {
  const started = Date.now();
  /** @type {string[]} */
  const skipped = [];

  for (const [i, step] of STEPS.entries()) {
    const position = i + 1 + "/" + STEPS.length;

    if (step.when !== undefined) {
      const verdict = step.when();
      if (!verdict.run) {
        heading("- " + position + "  " + step.name + " — SKIPPED (" + verdict.why + ")");
        skipped.push(step.name);
        continue;
      }
      heading("> " + position + "  " + step.name + "  (" + verdict.why + ")");
    } else {
      heading("> " + position + "  " + step.name);
    }

    const at = Date.now();
    const result = spawnSync(step.run, { cwd: ROOT, stdio: "inherit", shell: true });
    const seconds = ((Date.now() - at) / 1000).toFixed(1);

    if (result.status !== 0) {
      console.error(
        "\nFAILED at " + position + ' "' + step.name + '" after ' + seconds + "s: " + step.run,
      );
      console.error(
        "The gate stops at the first failure, exactly as the CI job does — every later step there" +
          " reports `skipped`, so continuing here would report something CI never would.",
      );
      process.exit(result.status === null ? 1 : result.status);
    }
    console.log("  ok (" + seconds + "s)");
  }

  const total = ((Date.now() - started) / 1000).toFixed(0);
  const note =
    skipped.length > 0 ? " (" + skipped.length + " skipped: " + skipped.join(", ") + ")" : "";
  console.log("\nGate passed in " + total + "s" + note + ".");
}

// Run when invoked, importable when not. The decision about the browser suite is the one piece of
// this file with a wrong answer available to it — a silent `false` would drop a check — so it has
// to be examinable without running twelve steps to see what it decided.
if (require.main === module) {
  main();
}

module.exports = {
  STEPS,
  browserSuiteApplies,
  e2ePathPrefixes,
  changedFiles,
  dirtyPaths,
  firstUnderPrefix,
};
