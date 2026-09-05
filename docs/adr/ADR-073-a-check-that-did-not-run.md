---
title: ADR-073 — A check that did not run reports nothing, and nothing looks like green
version: 1.1.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-073 — A check that did not run reports nothing, and nothing looks like green

**Status:** Accepted in part (Sprint 15), 2026-09-04, amended 2026-09-05.

- **v1.0.0 recorded the class and changed nothing.**
- **v1.1.0 closes one of the three instances with a mechanism** — the base-branch filter — and establishes by measurement, not by reading, that the obvious fix for the second instance would brick the repository. **The `paths` instance stays open, deliberately, and the branch-protection change must NOT be made yet.** See *The trap, measured* below.

---

## The class

This project already has a rule about conditional guards: *a guard is only as reliable as the thing it is conditional on.* That rule anticipates the condition being **wrong** — `if (production)` where `NODE_ENV` went missing, a default that makes an absence unobservable.

**This is the other half of it, and it had not been written down: the condition is not wrong. It simply does not fire.**

> **A conditional check that does not fail, but does not run. A check that did not run reports nothing — and nothing is indistinguishable from green.**

The asymmetry is what makes it worth its own record. A failing guard produces a red mark somebody investigates. A guard that never executes produces **the same visual result as success**: no red, nothing to click, a pull request that looks ready. Nobody is deceived by a lie; they are deceived by an absence.

---

## How it was found

Not by reasoning. By a pull request going red for a reason that had been true for two days.

ADR-069 made `RESEND_API_KEY` required at boot. The placeholder was added to `ci.yml`, and the Playwright harness — which composes the backend's environment **itself**, in `playwright.config.ts` — was missed. The backend could no longer start under the E2E harness.

**That breakage was invisible for two merged pull requests.** `e2e.yml` runs only on pull requests touching `apps/frontend/**`, `apps/e2e/**`, `packages/**` or its own file. #143 and #145 touched none of them, so the job never ran, reported nothing, and both merged green. It surfaced on #149 — the first frontend change afterwards — as a failure that looked like it belonged to that change and did not.

**Two pull requests were merged on the strength of a check that had not run.** They were correct, as it happens. That is luck, not a property of the process.

---

## What is actually conditional here — established by reading, not assumed

| Check | Condition | What silence looks like |
|---|---|---|
| `lint-typecheck-test-build` (`ci.yml`) | **None** at the workflow level — every PR to `main`, every push | Runs always. But every step is in **one job**, so a failure at step *n* leaves steps *n+1…* reported as `skipped` — neither pass nor fail |
| `browser-e2e` (`e2e.yml`) | `paths:` — `apps/frontend/**`, `apps/e2e/**`, `packages/**`, `.github/workflows/e2e.yml` | Does not run at all. No check appears on the PR |
| Trace upload (`e2e.yml`) | `if: failure()` | Legitimately conditional — it is an artefact of a failure, not a check |

**And the sharpest fact, which is about branch protection rather than the workflows:**

```
required_status_checks.contexts = ["lint-typecheck-test-build"]
strict = true
```

**`browser-e2e` is not a required check.** So it does not block a merge whether it runs or not: on a non-frontend PR it is silent, and on a frontend PR it can be red while the merge button stays available. On #149 it was red and treated as blocking — **by judgement, not by mechanism.**

The step-level case in `ci.yml` is the same class one level down, and this project has already paid for it: while the npm audit endpoint was unreachable, the audit step failed fourth and Typecheck, Test and Build reported `skipped` for hours. ADR-072 moved that step last, which fixes the *visibility* of that particular ordering and does nothing about the class.

---

## A second instance, found while writing this ADR, on the pull requests that carry it

`ci.yml` triggers on `pull_request: branches: [main]`. **A pull request whose base is another branch does not run it at all** — and the required check, `lint-typecheck-test-build`, is the job inside it.

Observed on this batch of work rather than reasoned about:

| Pull request | Base | Checks that appeared |
|---|---|---|
| Specimen page | `feat/dark-portal-tokens` | `browser-e2e` only |
| Terminal options (docs) | `feat/dark-portal-tokens` | **none at all** |
| This ADR | `main` | `lint-typecheck-test-build` |

**A stacked pull request gets no report from the one required check.** Not red, not pending — absent from the page, exactly as `browser-e2e` is absent from a backend-only pull request. The docs-only one has no checks whatsoever and reads as ready.

Two things follow, and the second is the uncomfortable one:

- **The class is not exotic.** It appeared three times in one week from three unrelated causes: a `paths` filter, a step ordering, and a base-branch filter. Each was invisible in a different way.
- **This ADR's own delivery demonstrates the problem it describes.** That is the strongest evidence available that the record is worth keeping — and a reminder that recognising the class in the abstract did not stop me shipping into it an hour later.

**Not fixed in v1.0.0. Fixed in v1.1.0** — the trigger is widened, and the reasoning is in *the base-branch instance, closed by mechanism* below.

---

## What is NOT an instance, and why the distinction matters

Several conditionals in the application read `NODE_ENV` and do nothing outside production: `StripeService`'s boot probe, `EmailService`'s refusal to touch the wire, `env.validation`'s production rules, `assertPlatformTermsPublished`.

**None of these belong to this class, and the reason is a design property worth naming: their condition is an argument, not an ambient fact.**

```ts
export function assertPlatformTermsPublished(nodeEnv: string, currentVersion: string): void {
  if (nodeEnv !== "production") return;
```

Both branches are reachable from a test because the condition is passed in. The same holds for the services, whose `ConfigService` is injected — the specs construct them with `NODE_ENV: "production"` and exercise the production branch directly.

**A conditional whose condition is injectable is testable. A conditional whose condition is the CI trigger itself is not** — nothing inside the repository can make a workflow have run.

---

## The options, and none is chosen here

**v1.1.0 note:** these four are the original texts and are kept rather than rewritten, because a measurement narrowed them afterwards. A′/B′/C′ below are these same options after the measurement; read this section for the reasoning and that one for what is actually on the table.

The structural point first, because every viable option is a version of it:

**The distinction between *did not run* and *passed* cannot be made by the thing that did not run.** It has to be made by something that always runs.

### A — every conditional job becomes required, and self-skips internally

The job is always triggered; the `paths` decision moves *inside* it, so it always reports a conclusion. GitHub then blocks a merge whenever a required check has not reported, and silence becomes impossible.

**Cost:** every pull request pays the job's setup even to skip. **Weakness:** the skip condition still lives in the job, and widening it is a one-line edit.

### B — one aggregating job that requires every other job to have reported

The Founder's candidate: a single required check with `needs:` on every other job, failing unless each reported a conclusion it recognises.

**Its stated weakness is real and is the same one ADR-056's register has: it holds a list, and a list gets edited to make a build green.** Worth recording because it has a known answer in this codebase: **ADR-060 faced exactly this shape and solved it by deriving the register instead of maintaining it.** `INDEX.md`'s hand-kept version line became `check-doc-index.js`, which computes the correspondence in both directions. The analogous move here is a check that **reads `.github/workflows/` and derives the expected set of jobs**, rather than a list someone types. That does not remove the weakness — it moves it to a place where editing it is visible as a change to the deriving rule rather than as a line in a config.

### C — remove the condition; run everything on every pull request

No silence, because nothing is conditional.

**Cost:** the E2E suite runs on backend-only and documentation-only pull requests. ADR-041 rejected that explicitly — *"a slow check that runs on everything starts getting ignored"* — but that reasoning was about minutes, and the minutes are now measurable rather than estimated.

### D — accept the silence and make it visible at merge time

A line in the pull-request report saying which checks did not run.

**The weakest option and named to be refused rather than forgotten:** it relies on a human noticing an absence, which is the exact perceptual failure this ADR is about.

---

## v1.1.0 — the base-branch instance, closed by mechanism

`ci.yml`'s `pull_request` trigger loses its `branches: [main]` filter. The required check now runs on a pull request into **any** base.

This is the smallest of the three instances and the only one whose fix has no trade-off worth deliberating: the required check is, by definition, the one thing that may not be conditional on anything, because **the distinction between *did not run* and *passed* cannot be made by the thing that did not run.** A filter on it made merge-readiness depend on where a branch happened to point.

**The reason it is a comment in the file and not only a line in this ADR:** the deleted filter looks like an omission. Somebody tidying the workflow re-adds it in one line and reintroduces the instance, and nothing goes red when they do — that is the whole property of this class. The comment states the cost as well, so the next reader is answering a recorded argument rather than an apparent oversight.

**Cost, accepted:** a stacked pull request now runs the full job, and runs it again after its post-merge rebase. Minutes, on branches that were previously merging unverified.

**What this does not do:** it does not make stacking cheap or recommended. CLAUDE.md's rule stands unchanged — branch from `main` unless the work genuinely depends on an open pull request. This makes the exception *verified*, not attractive.

---

## The trap, measured

The obvious next step — add `browser-e2e` to the required checks — was put to the test before being proposed, because `enforce_admins: true` means a mistake here cannot be clicked past by anybody, including the Founder.

**Method, and it is the point of this section:** a throwaway base branch was protected requiring `browser-e2e`, and a documentation-only pull request was opened into it. `main` was never touched; its protection was read before and after and is byte-identical. Everything was deleted afterwards.

**Reading:**

| Measured | Value |
|---|---|
| `e2e.yml` workflow runs for the head commit | **0** |
| `browser-e2e` in the check list | **absent** — not skipped, not pending, not neutral |
| Checks that did report | `lint-typecheck-test-build` **pass**, both Railway deploys **pass** |
| `statusCheckRollup.state` | **SUCCESS** |
| `mergeStateStatus` | **BLOCKED** |
| Merge API | *"the base branch policy prohibits the merge"* |

**The trap is real, and its shape is worse than "the pull request waits."**

- The block is **permanent**, not slow. Nothing will ever produce that check run: the workflow was never triggered, so there is no run to re-run and no button to press.
- **Every check on the page is green.** The rollup says SUCCESS. The blocker is the one name that is not on the list, which is the same perceptual failure as the original bug, arriving from the opposite direction — first a silence that read as success, now a success that hides a silence.
- The only two exits GitHub offers are `--auto` (wait forever) and `--admin` (an administrator override). CLAUDE.md forbids the second in as many words, and `enforce_admins: true` disables it anyway.

**A confirmation worth separating from the above, because it decides between the options below:** a workflow-level `paths:` filter that does not match produces **no workflow run at all** — measured as `total_count: 0` on #147's head, whose `github-actions` check suite contains exactly one check run. This is not the same as a job that GitHub skips: a job skipped by a job-level `if:` inside a workflow that *did* trigger still reports a conclusion, and a reported conclusion satisfies a required check. **The conditionality has to move from the workflow to the job for the check to be requirable at all.** That single fact is what makes option A cheap and option C unnecessary.

---

## The options for the `paths` instance, and none is chosen here

The order matters more than the choice: **the branch-protection change is the LAST step of whichever option is picked, never the first.** Doing it first blocks every backend and documentation pull request with no way back except deleting the rule again.

### A′ — move the condition from the workflow into the job

`e2e.yml` triggers on every pull request; the `paths` decision becomes a first job that computes whether the frontend changed, and `browser-e2e` `needs:` it and self-skips. The check then **always reports** — success or skipped — and can be required safely.

**Cost:** a few seconds of runner time per pull request for the decision job. **Weakness, unchanged from v1.0.0:** the skip condition still lives in the repository and widening it is a one-line edit — but it is now a visible edit to a job, not an invisible property of a trigger.

**Cheapest of the three, and the fact above is why:** it is the only one that makes the check requirable without changing what actually runs.

### B′ — a derived gate rather than a typed list

The Founder's candidate, and ADR-060's move applied here: one required aggregating job that **reads `.github/workflows/` and derives** the set of jobs that must have reported, instead of holding a list somebody maintains.

**What it buys over A′:** it closes the class rather than this instance. A future workflow that is conditional is caught by the deriving rule, not by somebody remembering. **What it costs:** a real script with a real failure mode, and CLAUDE.md's own warning applies to it directly — *a tool you wrote to check something errs in its own favour, and quietly*. `check-doc-index.js` is the precedent that it can be done well; it is also the precedent for how much work it is.

**Not exclusive with A′.** A′ is the mechanism; B′ is the guard that stops the next instance. Doing A′ first and B′ later loses nothing.

### C′ — remove the `paths` filter entirely

Every pull request runs the E2E suite. No silence, because nothing is conditional.

**Now measurable rather than estimated:** ADR-041 rejected this on the grounds that *"a slow check that runs on everything starts getting ignored"*. The suite's real cost should be read off recent runs before this is weighed again.

**Superseded in practice by the measurement above:** A′ achieves requirability without paying this, so C′ is now the expensive way to buy the same property.

### D — unchanged, still named to be refused

A line in the report listing checks that did not run. It relies on a human noticing an absence.

---

## The branch-protection change, written out so it is not re-derived

Recorded here rather than left in a conversation, because it is the step most likely to be taken out of order.

**Repository → Settings → Branches → the `main` rule → Require status checks to pass before merging → search `browser-e2e` → add → Save.**

**Do not do this yet.** Until A′ or C′ has merged, `browser-e2e` does not exist as a check on a backend-only or documentation-only pull request, and adding it makes those pull requests permanently unmergeable — measured above, not predicted. Two preconditions, both checkable:

1. The chosen option has merged to `main`.
2. A backend-only or documentation-only pull request has been observed to produce a `browser-e2e` check run with a conclusion — `skipped` counts, `absent` does not.

---

## Consequences

**The rule to carry forward, in one line:** when a check is made conditional, ask what its silence will look like — and if silence is indistinguishable from success, the condition needs something that always runs to speak for it.

**The rule v1.1.0 adds, and it is about the fix rather than the bug:** *making a silent check required does not make it speak.* Requiring a check that cannot report converts an invisible gap into a permanent block, and the block is invisible too — every check on the page stays green. Before requiring anything, establish that it reports on the pull requests where it does **not** apply, because that is the case the requirement is being added for.

**A note on how that was established, since the method is the reusable part:** the question was answered by protecting a throwaway branch and opening one pull request into it, not by reading GitHub's documentation and not by trying it on `main`. A branch-protection rule is cheap to create and delete and expensive to be wrong about — `enforce_admins: true` means there is no override — so the experiment belongs somewhere disposable. This is the same discipline CLAUDE.md asks for on tools that check things: run it where the answer is already known, or where being wrong costs nothing.

**This applies beyond CI.** Any mechanism that can decline to execute has the same property: a scheduled job that did not fire, a webhook that was never delivered, a poller that was not running. In each case the absence of a signal reads as the absence of a problem. `EmailDelivery` (ADR-069) is this project's one existing answer to that shape — a record written **before** the attempt, so that "nothing happened" is itself a visible row rather than an empty result set.
