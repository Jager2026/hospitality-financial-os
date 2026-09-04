---
title: ADR-073 — A check that did not run reports nothing, and nothing looks like green
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-073 — A check that did not run reports nothing, and nothing looks like green

**Status:** Proposed (Sprint 15), 2026-09-04. **The class is recorded; the remedy is not chosen.** No workflow is changed by this ADR.

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

## What this ADR deliberately does not do

**It changes no workflow.** The class is worth recording on its own — the next instance will not look like this one, and the value of the record is the shape rather than the fix.

**It does not make `browser-e2e` required.** That is a branch-protection change, and `IMPLEMENTATION_PLAN.md` already carries a rule from ADR-072's decision: **protection rules are not edited while the queue is blocked.** Whether it should be required is part of the same decision as the options above, not a separate quick fix.

---

## Consequences

**The rule to carry forward, in one line:** when a check is made conditional, ask what its silence will look like — and if silence is indistinguishable from success, the condition needs something that always runs to speak for it.

**This applies beyond CI.** Any mechanism that can decline to execute has the same property: a scheduled job that did not fire, a webhook that was never delivered, a poller that was not running. In each case the absence of a signal reads as the absence of a problem. `EmailDelivery` (ADR-069) is this project's one existing answer to that shape — a record written **before** the attempt, so that "nothing happened" is itself a visible row rather than an empty result set.
