#!/usr/bin/env node
// @ts-check
/**
 * Preflight gate for manual production deploys (`railway up`).
 *
 * Why this exists — a real incident, not a hypothetical: a production deploy was once built from
 * the Sprint 12 commit while the ADR-031 code had already been written and tested but not
 * committed. It was caught before it did harm, but only because someone deliberately compared the
 * two by hand. Anything that depends on remembering to check will eventually not be checked.
 *
 * The underlying weakness is structural, not human: `railway up` uploads the working directory,
 * so what gets deployed is whatever happens to be on disk at that moment. Railway records no
 * commit for such a deploy at all — `resolvedFileConfig.commitHash` is literally `null` after one
 * (confirmed directly against the API, not assumed). A deploy that cannot name its own commit
 * cannot be audited later, which for a service that moves money is the actual problem.
 *
 * This script refuses the deploy unless the working directory provably equals a specific commit
 * that is already on `origin/main`. It does not warn and continue — a failed check exits non-zero
 * and `railway up` never runs, because a gate that can be ignored is documentation, not a gate.
 *
 * Deliberately NOT skippable by a flag. If a deploy is genuinely needed from something other than
 * a clean `origin/main`, that is a real decision and should be made by invoking `railway up`
 * directly and knowingly — not by passing `--force` to the thing whose whole job is to say no.
 */

const { execFileSync } = require("node:child_process");

/**
 * Trimmed, for the single-value reads below — a branch name, a SHA, a count — where the trailing
 * newline is noise and there is no leading whitespace to lose.
 *
 * @param {...string} args
 * @returns {string}
 */
function git(...args) {
  return gitRaw(...args).trim();
}

/**
 * Untouched, for output where whitespace is part of the format.
 *
 * The distinction is made at the call site on purpose, because collapsing the two is a defect this
 * repository has already shipped once. `scripts/gate.js` had a single trimming helper used for both
 * kinds of read, and `git status --porcelain` is the second kind: its lines are `XY path`, and a
 * file modified but not staged is ` M path`. Trimming the whole output removes the leading space of
 * the FIRST line only, and the parser's `slice(3)` then ate that one path's first character — so
 * `apps/frontend/x` was read as `pps/frontend/x` and the browser suite was skipped for a change
 * that needed it (ADR-077's amendment).
 *
 * **Here the same pairing was harmless, and it is fixed anyway.** This file only counts the lines
 * and prints them, so the corruption cost one misaligned character in a failure message and never
 * changed the answer. That is the whole reason to fix it now rather than when it matters: the two
 * uses are one edit apart, and the next person to add `line.slice(3)` here would inherit the bug
 * rather than write it.
 *
 * @param {...string} args
 * @returns {string}
 */
function gitRaw(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const failures = [];

// 1. Must be on main. Deploying production from a feature branch is almost always a mistake, and
//    when it isn't, it should be a conscious act rather than a side effect of forgetting to switch.
let branch = "";
try {
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    failures.push(`On branch "${branch}", not "main".`);
  }
} catch (err) {
  failures.push(
    `Could not determine the current branch: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// 2. Working tree must be clean — including untracked files, which `railway up` uploads too.
//    This is the check that would have caught the original incident from the opposite direction:
//    uncommitted work present at deploy time means the deployed artifact has no commit that
//    describes it.
let dirty = "";
try {
  dirty = gitRaw("status", "--porcelain");
  if (dirty.trim()) {
    const lines = dirty.split("\n").filter(Boolean);
    failures.push(
      `Working tree is not clean — ${lines.length} entr${lines.length === 1 ? "y" : "ies"}:\n` +
        lines.map((l) => `      ${l}`).join("\n"),
    );
  }
} catch (err) {
  failures.push(
    `Could not read the working tree state: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// 3. HEAD must equal origin/main — fetched fresh, not trusted from a stale local ref. Without the
//    fetch this check would pass happily against an origin/main that moved days ago, which is
//    precisely the false confidence it is supposed to remove.
let head = "";
let remote = "";
try {
  execFileSync("git", ["fetch", "origin", "main", "--quiet"], { stdio: "inherit" });
  head = git("rev-parse", "HEAD");
  remote = git("rev-parse", "origin/main");
  if (head !== remote) {
    const ahead = git("rev-list", "--count", `${remote}..${head}`);
    const behind = git("rev-list", "--count", `${head}..${remote}`);
    failures.push(
      `HEAD does not match origin/main (ahead ${ahead}, behind ${behind}).\n` +
        `      HEAD:        ${head}\n` +
        `      origin/main: ${remote}`,
    );
  }
} catch (err) {
  failures.push(
    `Could not compare HEAD against origin/main: ${err instanceof Error ? err.message : String(err)}`,
  );
}

if (failures.length > 0) {
  console.error("\n  Deploy refused — the working directory is not a clean, pushed commit.\n");
  failures.forEach((f) => console.error(`  ✗ ${f}\n`));
  console.error("  Nothing was deployed. Commit and push, or check out main, then try again.\n");
  process.exit(1);
}

console.log(`\n  Preflight OK — deploying commit ${head}`);
console.log(`  branch: ${branch}  ·  working tree clean  ·  matches origin/main\n`);
