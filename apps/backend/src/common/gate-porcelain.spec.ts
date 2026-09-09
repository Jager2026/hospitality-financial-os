import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `scripts/gate.js` reading `git status --porcelain` — the format where leading whitespace is data.
 *
 * Lives in this suite for the same reason as `repo-invariants.spec.ts` and `ci-audit-gate.spec.ts`:
 * it is the suite that runs on every pull request, and the subject is repository infrastructure
 * rather than backend behaviour.
 *
 * ── The defect this exists for ────────────────────────────────────────────────────────────────
 *
 * `git()` returned `stdout.trim()`. A porcelain line is `XY path`, and a file modified but not
 * staged is ` M path` — a leading SPACE. `trim()` removes it from the FIRST line of the output
 * only, after which `slice(3)` eats that one path's first character. Measured on 2026-09-09
 * (ADR-077's amendment): an unstaged edit to `apps/frontend/scripts/check-public-env.mjs` was read
 * as `pps/frontend/...` and the gate answered *"nothing changed under: apps/frontend/ …"* — so the
 * browser suite was skipped for a change that requires it, silently, in the direction of running
 * less. It struck precisely the one respect in which the gate is deliberately wider than CI:
 * uncommitted work.
 *
 * ── Why the fixtures look the way they do ─────────────────────────────────────────────────────
 *
 * **A single-entry fixture is not enough, and neither is any fixture built from the wrong kind of
 * change.** The corruption applies to the first line of the output, and only lines whose status
 * begins with a space carry the vulnerable shape: a STAGED file prints `M ` and an UNTRACKED one
 * `??`, neither of which loses anything to `trim()`. A test written with `writeFileSync` on a new
 * file, or with `git add` before the check, passes against the broken code and proves nothing.
 *
 * So every fixture below commits its files first and then modifies them **without staging**, and
 * every assertion is on the FIRST path in sort order — with a second entry present to show the
 * rest of the list was never in question.
 *
 * ── Why a real repository rather than hand-written strings ────────────────────────────────────
 *
 * The defect lived in the seam between running the command and parsing it, not in either half. A
 * parser fed a hand-written ` M path` string handles it correctly and always did; the string that
 * reached the parser was the broken part. Feeding these tests fabricated porcelain output would
 * have passed against the broken code — which is the whole reason `dirtyPaths` takes a `cwd`.
 */

type DirtyPaths = (cwd?: string) => string[] | null;
type FirstUnderPrefix = (
  changed: string[],
  prefixes: string[],
) => { file: string; prefix: string } | null;

let dirtyPaths: DirtyPaths;
let firstUnderPrefix: FirstUnderPrefix;
let e2ePathPrefixes: () => string[] | null;

const repos: string[] = [];

/**
 * A throwaway repository whose working tree is dirty in the one way that matters.
 *
 * `files` are created, committed, and then appended to without being staged, so each appears as
 * ` M path`. Order in the argument is irrelevant — git sorts porcelain output by path, and which
 * path lands first is the whole subject here.
 */
function repoWithUnstagedEdits(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-porcelain-"));
  repos.push(dir);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "--quiet");
  git("config", "user.email", "gate-test@example.com");
  git("config", "user.name", "Gate Test");
  // Line endings are left to git's defaults deliberately: the fixture must look like the working
  // trees this code actually reads, and normalising them here would be tuning the fixture to the
  // implementation.
  for (const file of files) {
    const full = join(dir, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "committed\n");
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "fixture");
  for (const file of files) appendFileSync(join(dir, file), "modified, not staged\n");
  return dir;
}

beforeAll(async () => {
  const modulePath = join(__dirname, "..", "..", "..", "..", "scripts", "gate.js");
  const loaded = await import(pathToFileURL(modulePath).href);
  const mod = (loaded.default ?? loaded) as {
    dirtyPaths: DirtyPaths;
    firstUnderPrefix: FirstUnderPrefix;
    e2ePathPrefixes: () => string[] | null;
  };
  dirtyPaths = mod.dirtyPaths;
  firstUnderPrefix = mod.firstUnderPrefix;
  e2ePathPrefixes = mod.e2ePathPrefixes;
});

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

/**
 * The timeout is on the suite because the cost is a property of the FILE.
 *
 * Every case here builds a real repository: `init`, two `config`s, `add`, `commit`, and then the
 * `status` under test — five to seven process spawns, against vitest's 5s default, which is per
 * test rather than per spawn. Standalone each case takes about 600–900ms; inside the full suite,
 * with every other file running in parallel, the first one crossed 5s on its first gate run.
 *
 * This is the same defect this project fixed in `check-public-env.spec.ts` one pull request ago,
 * reappearing in a test written by the session that had just fixed it — which is the argument for
 * writing the budget down at the moment the spawns are added rather than when a run goes red.
 * Stated on the suite rather than raised globally, so it cannot hide the same problem in tests that
 * do far less.
 */
describe("gate.js reading git status --porcelain", { timeout: 30_000 }, () => {
  it("keeps the first character of the FIRST reported path — the one `trim()` used to eat", () => {
    const dir = repoWithUnstagedEdits(["a-first.txt", "z-last.txt"]);

    // Deep equality rather than a `toContain`: this pins both halves of the claim — nothing lost
    // from the first path, and nothing invented anywhere else.
    expect(dirtyPaths(dir)).toEqual(["a-first.txt", "z-last.txt"]);
  });

  it("so a first-sorting frontend file makes the browser suite apply, instead of vanishing", () => {
    // The measured case, reconstructed. `apps/…` sorts before `docs/…`, so the file that decides
    // the answer is exactly the one that used to be corrupted.
    const dir = repoWithUnstagedEdits(["apps/frontend/scripts/check-public-env.mjs", "docs/x.md"]);
    const paths = dirtyPaths(dir);

    expect(paths).toEqual(["apps/frontend/scripts/check-public-env.mjs", "docs/x.md"]);

    // Asserted against the REAL prefix list, read out of e2e.yml, so this cannot drift from the
    // condition the gate actually applies.
    const prefixes = e2ePathPrefixes();
    expect(prefixes, "e2e.yml's PATHS must be readable, or the gate fails open").not.toBeNull();
    expect(firstUnderPrefix(paths as string[], prefixes as string[])).toEqual({
      file: "apps/frontend/scripts/check-public-env.mjs",
      prefix: "apps/frontend/",
    });
  });

  it("and a first-sorting file that is under NO prefix declines honestly, not by losing a letter", () => {
    // The other half of the pair, and the reason it is here: a `false` produced by a corrupted path
    // looks identical to a `false` produced by the rule. This one is only allowed to be false while
    // its paths are intact, so the two cannot be confused.
    //
    // `.prettierignore` sorts before `apps/`, which is what makes it the case worth writing: on the
    // broken code it became `rettierignore` — still under no prefix, still `false`, and still wrong.
    const dir = repoWithUnstagedEdits([".prettierignore", "docs/x.md"]);
    const paths = dirtyPaths(dir);

    expect(paths).toEqual([".prettierignore", "docs/x.md"]);

    const prefixes = e2ePathPrefixes();
    expect(firstUnderPrefix(paths as string[], prefixes as string[])).toBeNull();
  });

  it("reports a rename by its destination, and a staged edit by its path", () => {
    // Neither shape is affected by the defect — a rename prints `R  old -> new` and a staged edit
    // `M  path`, both starting in column one — which is exactly why they belong here: they are what
    // a test written without knowing the mechanism would reach for, and both pass against the
    // broken code. Kept as a statement of what the parser must also do, and as the reason the three
    // tests above had to be built out of UNSTAGED edits specifically.
    //
    // The expected shapes were read off real output before being written down, after a first draft
    // asserted a single `renamed.txt` for a fixture that produced two entries: staging an edit and
    // then moving the file defeats git's rename detection, so it printed a delete and an add.
    const dir = mkdtempSync(join(tmpdir(), "gate-porcelain-rename-"));
    repos.push(dir);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    };
    git("init", "--quiet");
    git("config", "user.email", "gate-test@example.com");
    git("config", "user.name", "Gate Test");
    writeFileSync(join(dir, "kept.txt"), "committed\n");
    writeFileSync(join(dir, "staged.txt"), "committed\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "fixture");

    git("mv", "kept.txt", "renamed.txt"); // -> `R  kept.txt -> renamed.txt`
    appendFileSync(join(dir, "staged.txt"), "edited\n");
    git("add", "staged.txt"); // -> `M  staged.txt`

    expect(dirtyPaths(dir)).toEqual(["renamed.txt", "staged.txt"]);
  });

  it("returns an empty list for a clean tree, rather than a phantom entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-porcelain-clean-"));
    repos.push(dir);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    };
    git("init", "--quiet");
    git("config", "user.email", "gate-test@example.com");
    git("config", "user.name", "Gate Test");
    writeFileSync(join(dir, "only.txt"), "committed\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "fixture");

    // Empty output split on "\n" yields [""], which must not become a one-entry list. That would
    // be a phantom change, and the gate fails OPEN on a non-empty list — so this direction costs
    // a browser suite run rather than skipping one, but it is still a lie about the tree.
    expect(dirtyPaths(dir)).toEqual([]);
  });
});
