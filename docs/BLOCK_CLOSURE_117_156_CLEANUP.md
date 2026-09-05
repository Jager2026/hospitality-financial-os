---
title: BLOCK_CLOSURE_117_156_CLEANUP
version: 1.0.0
status: Active — closure report, part 4: the only part that changes anything
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# BLOCK CLOSURE — PR #117 → #156, part 4 of 4: the cleanup

> "Twenty-four local branches, and the obvious test for whether they were safe to delete would have
> kept all of them."

**Scope: workspace hygiene, and it is the only part of this closure allowed to change anything.**
Parts 1–3 reported and fixed nothing. Every deletion below is justified, and everything that might
be needed was kept and is named.

---

# What was deleted, and why each was safe

## 23 local branches, 2 remote branches

**The instrument had to be corrected before anything was deleted, and this one would have caused
real harm rather than a false report.**

The obvious test is `git rev-list main..<branch>` — does the branch hold commits that main does
not? Run against the twenty stale local branches, **nineteen came back with commits "not in main"**,
which reads as nineteen branches holding unmerged work.

**It is the wrong test, and it is wrong for a reason this project has already written down.** Every
one of those branches was **squash-merged**: the merge puts a single new commit on `main`, so the
branch's original commits never appear there, no matter how completely its content did. Deleting on
that signal would have been reckless; *keeping* on it would have preserved twenty-three dead
branches forever, and quietly, because the number never goes down.

**The correct test is the pull request's own state**, and it was applied one branch at a time:

| What | Count | Evidence |
|---|---|---|
| Local branches whose upstream was gone | 20 | **All 20 have a MERGED pull request** — checked individually, not sampled |
| `feat/accountant-role` | 1 | PR #140 MERGED; the remote branch had simply not been deleted at merge time |
| `feat/product-identity` | 1 | Zero commits absent from `main` — contained outright |
| `feat/product-identity-wordmark` | 1 | **No pull request exists**, so the state had to be established from the code: all 22 files it touches are present in `main`, 14 byte-identical; `git log --diff-filter=A` names **PR #67** as the merge that introduced `wordmark.tsx` and `login/page.tsx` |
| Remote `docs/block-closure-110-116` | 1 | PR #117 MERGED |
| Remote `feat/accountant-role` | 1 | PR #140 MERGED |

**The last row of the local list is the one worth keeping in mind.** A branch with no pull request
has no record to consult, and the two candidate answers — "someone forgot to open one" and "it
merged under a different number" — look identical from the branch. Finding the commit that
introduced its headline file is what settled it. **Absent a record, the file's own history is the
record.**

`origin` now holds exactly `main`. Locally, exactly `main`.

## The development database

Measured before: **267 OutboxEvents, 193 of them unpublished, 750 LedgerLines, 208 Restaurants, 195
Organizations** — from three suite runs in one day, with a reset before two of them.

**Reset, and it is not tidiness.** `IMPLEMENTATION_PLAN.md` already argues this: past the
fifty-per-poll batch the suite reports failures that have nothing to do with the code under test,
and 193 is nearly four batches. The entry's own phrasing is the right one — `db:reset` is a
precondition of a trustworthy run, not hygiene. Verified after: every counted table at zero, then
re-seeded.

---

# What was NOT deleted, and why

| Kept | Reason |
|---|---|
| `.obsidian/` | The Founder's own editor configuration. Already in `.gitignore` (line 39), never in the repository, and not mine to remove |
| `apps/frontend/.next` (114 MB), `apps/backend/dist` (1.9 MB), the three `packages/*/dist` | Build output. Deleting it is churn, not cleanup — the next build recreates it, and nothing reads a stale copy |
| `apps/e2e/test-results/.last-run.json` (46 bytes) | Playwright's own state file, ignored, and it is what tells a re-run which tests failed last |
| Every dependency | See below |

## No unreferenced dependencies were found — with the limit stated

Every dependency across the seven `package.json` files is referenced by name somewhere in its own
package. **That is a weak claim and is reported as one:** the check is a substring search, so a
package whose name happens to appear in a comment or a config string would pass while being unused.
The claim is therefore *"nothing was found"*, not *"nothing is unused"* — and since the conclusion is
to delete nothing, a weak instrument is in the safe direction here.

## The repository root is clean

**Zero untracked, non-ignored files** anywhere in the working tree. `CLAUDE.md`'s rule — every file
has an obvious reason to exist, no debug scratch, no leftovers — holds without any action.

---

# Recorded, not fixed: the suite-interference variant

Added to `IMPLEMENTATION_PLAN.md`'s existing *"the suite should clean up after itself"* entry,
because it contradicts what that entry currently describes.

**Everything the entry says is about accumulation across runs.** The failure measured while running
part 3's gate was **interference inside a single run**, on a database reset immediately beforehand:
two specs timed out at 5.06 s while the real Outbox poller they boot repeatedly errored on
deliberately-malformed rows written by `outbox-poller.service.spec.ts` in a parallel vitest worker.
Both files then passed in isolation, 37 of 37.

**The counter cannot see this variant, and the reason is structural rather than a tuning problem: it
measures at setup, and at setup the debris does not exist yet.** Its printout for that run read
`outbox: 0 (0 unpublished)` and was correct. So it is not merely reporting early — it is measuring a
quantity that is *necessarily* zero at the moment it is taken.

**The consequence for whoever schedules the repair, which is why this is worth writing down rather
than mentioning:** a cleanup hook between test files closes the accumulation variant and would have
left this failure exactly where it is. Only per-file transactional rollback closes both.

Its own axis, deliberately. This is test infrastructure, and it does not belong in a cleanup.

---

# Shown, not decided: are the three empty packages needed at all?

The Founder's question, and the reason it belongs here: **if a package is empty and unwanted,
deleting it closes part 2's fifth silence cause for nothing — cheaper than any mechanism.**

## The facts

| | `packages/shared` | `packages/types` | `packages/ui` |
|---|---|---|---|
| Source files | 1 | 1 | 1 |
| Lines | 3 | 3 | 3 |
| Content | a comment and `export {}` | same | same |
| Importers, anywhere | **0** | **0** | **0** |
| `test` script | `echo "no tests yet"` | same | same |
| Dependencies | `typescript` only | same | same |
| Build output | 3 KB of compiled nothing | same | same |

**Nothing outside these three directories references `@hospitality-os/shared`, `/types` or `/ui`** —
checked across every `.ts`, `.tsx`, `.json`, `.yml` in the repository.

**What would have to change if they went:** `pnpm-workspace.yaml`'s `packages/*`, the root `build`
script's `--filter=./packages/*`, and `e2e.yml`'s `packages/**` path filter. All three would remain
valid and simply match nothing, so deletion is three directories and no edit — but leaving three
globs pointing at an empty directory is its own small lie.

## The case for deleting all three

**Each file cites the rule it violates.** `packages/shared/src` says, in its own comment, *"Empty
until a real module needs to share code — see CLAUDE.md (Nothing should be built just in case)."* It
exists just in case. That is not a gotcha: it is the clearest statement available that the packages
were scaffolding, and scaffolding that has stood empty through fourteen sprints is a prediction that
did not come true.

**It closes the fifth silence cause without a mechanism.** Part 2 established that
`pnpm --recursive run` exits 0 when nothing has the script, so four of six packages report a passing
test suite having executed nothing. Three of those four are these. Delete them and the gap shrinks
to `apps/e2e`, which is deliberate, documented, and has a real suite reached another way.

**A package that is re-created when needed costs one command.** `pnpm init` plus a tsconfig is
minutes; the three have cost fourteen sprints of appearing in every workspace listing, every
recursive script run, and every path filter.

## The case for keeping them

**`packages/types` is the one with a named, near-term consumer.** Its comment states the intent
precisely — *"Populated as real endpoints are built (Sprint 2+) so types are derived from working
code, not written speculatively"* — and `API_Contract.md` describes 67 routes the frontend codes
against by hand today. The first shared-type extraction is a plausible next sprint, not a
hypothetical.

**Deleting is not free of risk in one specific way:** `e2e.yml`'s `paths:` filter includes
`packages/**`, and that filter is currently part of a live, undecided question (ADR-073, the
`required + paths` trap). Removing a path from a filter that is simultaneously under review means two
people reasoning about the same file from different assumptions.

**And the honest counterweight to the "just in case" argument:** an empty directory with a
three-line file is close to the cheapest possible form of a deferred decision. It is visible, it is
documented, and it has never once been in anyone's way except in the silence-cause audit that found
it.

## The middle option, stated because it is not obviously worse

**Delete `packages/shared` and `packages/ui`; keep `packages/types`.** The two deleted are the ones
whose triggers are the vaguest — *"until a real module needs to share code"*, *"until the frontend
needs a component in more than one place"* — and the one kept has a specific consumer and a specific
sprint. This shrinks the silence surface from four packages to two and leaves the one directory
somebody can name a use for.

**Not decided here.** Whichever way it goes, the `echo` test scripts should stop existing: either the
package goes, or its script says what it is rather than reporting success.

---

# What remains from parts 1–3, and is not done here

**The "fix now" basket is still open**, deliberately — this pull request is workspace hygiene, not
the fixes. In risk order:

1. **`IMPLEMENTATION_PLAN.md`'s statement that the seed never runs automatically** — part 1's
   first-by-risk finding, the one read in a panic.
2. **Three scripts outside any compiler**, one of which deletes production rows, and the hand-typed
   `include` list that let them escape.
3. **`PERSONAL_DATA_MAP.md`'s drift** — `OutboxEvent`, `EmailDelivery`, `Shift`, six `User` columns.
4. **`THREAT_MODEL.md:187` against `check-audit.js`** — an empty ignore list described as holding
   four entries.
5. **The seventeen weak status assertions**, which need the 403-versus-404 classification settled
   first (part 3) before a single one is changed.
6. The `agreement-versions.ts` docstring claiming an acceptance that is not recorded.
