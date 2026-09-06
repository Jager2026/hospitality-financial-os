---
title: ADR-077 — The local gate and the workflow are two lists, and nothing makes them agree
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-077 — The local gate and the workflow are two lists, and nothing makes them agree

**Status:** Proposed (Sprint 15), 2026-09-06. **Options only — no decision.** The gate itself is
built (`pnpm run gate`); what is open is whether its step list is kept honest by a mechanism or by
remembering, and this document exists so the answer is chosen rather than defaulted into.

---

## What was fixed, and the hole it leaves

Two of CI's checks — `check-doc-index.js` and `check-audit.js` — lived only in
`.github/workflows/ci.yml`. Nothing in any `package.json` called them, so **the gate could not be
run in full by anyone, on any machine.** It was a list of commands held in a person's head, and a
list held in a head is run selectively. That is not a hypothesis: in #176 a documentation version
was bumped without its register row, every local check was green, and CI failed on the one check
that could not be run locally.

`scripts/gate.js` now runs every `run:` step of `ci.yml` in order, plus the browser suite from
`e2e.yml`, plus the dependency scan last.

**The hole: there are now two lists of the same steps.** The workflow's, and the gate's. Nothing
compares them. **A step added to CI and not to the gate returns us to exactly the position this
change was meant to end** — and it returns us there silently, because a gate that is missing a
check still passes.

---

## What the comparison would actually have to handle

Worth stating before the options, because it is what separates a five-line check from a real one.

- **Not every CI step belongs in the gate.** "Compose Stripe and Resend CI placeholders" invents
  random credentials for a runner with no `.env`, writing them to `$GITHUB_ENV`. Running it locally
  would overwrite a developer's real test keys with nonsense. So any comparison needs an explicit
  list of steps the gate deliberately does not run — and **an exception list is the exact structure
  that decays** (`CLAUDE.md`: the permission matrix that went stale for a sprint, the audit ignore
  list kept deliberately empty). Whatever the shape, adding an entry has to feel like a decision.
- **`uses:` steps have no local equivalent** — checkout, `pnpm/action-setup`, `setup-node`. They
  are the runner existing, not a check.
- **Two workflows, not one.** `browser-e2e` lives in `e2e.yml`, runs in its own job with its own
  services, and is conditional on the changed paths. The gate mirrors that condition rather than
  ignoring it, because a slow check that always runs is one people learn to skip (ADR-041).
- **Order is load-bearing in one place.** The dependency scan is last on purpose (Founder decision,
  2026-09-04): it depends on a third party, and a failure there used to hide whether our own code
  was green. A comparison that only checks set membership would let that ordering be lost.

---

## Option 1 — an invariant that reads both files

A test in `repo-invariants.spec.ts` parses `ci.yml`'s `run:` steps and `scripts/gate.js`'s `STEPS`,
and asserts the gate contains each CI step, in the same relative order, except for an explicit
skip list with a written reason per entry.

**Price:** a YAML-shaped parse maintained by us (the multi-line `run: |` blocks are the awkward
part), plus the skip list — the decaying structure named above. **Buys:** both files stay readable
on their own, per-step granularity in the Actions UI is untouched, and the check runs inside
`pnpm run test`, which the gate itself calls — so the gate verifies its own completeness.

**The specific risk, named because this project has paid for it three times:** the parser is an
instrument we wrote, and an instrument errs in its own favour. It must be run against a case whose
answer is known — a step added to `ci.yml` and not to the gate **must** turn the test red — before
it is believed.

## Option 2 — the gate derives itself from the workflow

`gate.js` reads `ci.yml` at runtime and executes the `run:` of each step in order.

**Price:** drift becomes impossible, but the gate stops being readable — you can no longer see what
it runs without running it. It must still skip `uses:` steps and the placeholder step, so the
exception list does not disappear, it just moves somewhere less visible. And job-level `env:`,
services and container images are still the workflow's and still unreproducible locally, so the
derivation is partial while looking total. **Buys:** one list, by construction, which is strictly
stronger than any check over two.

## Option 3 — invert it: CI calls the gate

`ci.yml`'s job becomes a single step, `pnpm run gate`. One list, and it is the local one.

**Price:** the Actions UI loses per-step results — one red step instead of "Format check ✗", and
the log is where you find out which check failed. That directly undoes what the 2026-09-04 ordering
decision bought: the value of the audit running last is that **the other checks have already
reported** on the checks page. Collapsed into one step, "is our code green?" needs the log again.
Also `browser-e2e` cannot fold in — different job, different services, its own condition — so this
unifies most of CI, not all of it. **Buys:** the strongest guarantee, for a real cost in
diagnosability.

## Option 4 — nothing mechanical; a line in the PR checklist

**Price:** it is a habit, and this project has written down twice that a check living in a habit
stops the day the habit does. **Buys:** nothing to build, nothing to maintain, no false confidence
from a parser nobody re-verified.

---

## Not decided

The recommendation, offered as one and not acted on: **Option 1**, because it keeps the two files
readable and the per-step reporting that the audit-ordering decision depends on, and because it is
the only option whose cost is bounded to a test we already run. Option 3 is the strongest guarantee
and the one to reach for if per-step reporting ever stops mattering.

**Trigger, if nothing is chosen now: the next step added to `ci.yml`.** That is the moment the two
lists can first disagree, and the moment somebody is already editing the file that would make them
agree.
