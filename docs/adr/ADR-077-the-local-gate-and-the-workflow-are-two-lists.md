---
title: ADR-077 — The local gate and the workflow are two lists, and nothing makes them agree
version: 1.3.0
status: Rejected
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-077 — The local gate and the workflow are two lists, and nothing makes them agree

**Status: REJECTED, 2026-09-13.** No mechanism is built, and the reasoning is in *Re-costed on
2026-09-13* at the end — including the argument for closing that does **not** work, because it was
the tempting one. In short: the options really did get cheaper, and it did not matter, because the
defect they guard against **cannot let anything through**. The gate is advisory — nothing but a
human typing `pnpm run gate` ever invokes it — so a step missing from it produces a red CI check on
the next push, one round trip later. The analysis below stands as written and is worth reading
before reopening.

**Status when written:** Proposed (Sprint 15), 2026-09-06. **Options only — no decision.** The gate
itself is built (`pnpm run gate`); what is open is whether its step list is kept honest by a
mechanism or by remembering, and this document exists so the answer is chosen rather than defaulted
into.

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

---

## Amendment, 2026-09-09 — the lists can be identical and still disagree

**This document framed the risk as two lists that can drift apart. On 2026-09-09 the gate and the
workflow disagreed about whether the browser suite applied while their lists were byte-identical** —
the gate reads `PATHS` straight out of `e2e.yml`, which is exactly the defence Option 2 was meant to
provide, and it held. What differed was not the list. It was **the base each side diffed against.**

Recorded here rather than as a new ADR because it is the same decision's blind spot: a mechanism
that makes the two *lists* agree does not make the two *answers* agree.

### The measurement

Pull request #188, run 34357052701. The gate reported the browser suite **skipped**; CI **ran** it.

Both sides compute the same thing — `git diff --name-only <base>...HEAD`, a three-dot diff anchored
at the merge base — and both then test each path against the same four prefixes. The base was
identified by reproducing CI's own file list exactly:

| base | files in the diff | `apps/frontend/` among them | verdict |
|---|---|---|---|
| `d5eeeb6` — `main` **before** #187 merged | 15 | yes (2) | matches CI's printed list exactly |
| `e5bb555` — `main` **after** #187 merged | 5 | no | matches the gate's answer |

So the runner's `origin/main` was **one merge behind the real `main`**, roughly fifteen hours after
that merge landed, and it pulled two already-merged `apps/frontend/` files into the diff. CI ran the
suite over work that had already been verified on its own pull request.

### The direction that would matter, and why it cannot come from the base

The harmless direction is the one observed: a stale base makes the changed set **larger**, so a side
runs a suite it did not need to. The question worth answering is the opposite one — **can a base
difference make the gate skip a change CI would catch?**

**No, and this is a property of the three-dot diff rather than a fact about today's commits.** Both
sides anchor at `merge-base(base, HEAD)`, which is by construction an ancestor of `HEAD`. Every file
the branch's own commits touch is therefore in *every* such diff, whichever ancestor is chosen;
moving the base can only add or remove **other** commits' files. Measured rather than reasoned: a
throwaway branch whose single commit edits one file under `apps/frontend/`, diffed against five
different bases — the fork point, an ancestor of it, and three later `main`s:

```
base c5581d9 (the fork point)        -> 1 file under apps/frontend/
base c684118 (older than the fork)   -> 7
base d5eeeb6                         -> 1
base e5bb555                         -> 1
base 0dbb4e0                         -> 1
```

Never zero. **A base difference produces false positives only.**

### But the dangerous direction does exist — from somewhere else entirely

Looking for it turned it up, and it is not in the base or in the list. It is in
`scripts/gate.js`'s own `git()` helper:

```js
return r.stdout.trim();          // strips the leading space of the FIRST porcelain line
...
const path = line.slice(3).trim(); // then slices 3 characters off a line that is now 1 shorter
```

`git status --porcelain` prints `XY path`, and a file modified but not staged has a **leading
space** — ` M apps/frontend/x.tsx`. `trim()` removes it from the first line of the output, and the
subsequent `slice(3)` therefore eats the first character of that path. Measured on the real exported
function, not a copy (`gate.js` exports `browserSuiteApplies` and `changedFiles` for exactly this
kind of examination):

```
git status --porcelain          gate's changedFiles()
 M package.json             ->  ackage.json
 M apps/frontend/…mjs       ->  pps/frontend/scripts/check-public-env.mjs
                                browserSuiteApplies() -> { run: false,
                                  why: "nothing changed under: apps/frontend/ …" }
```

With any path sorting earlier made dirty as well, the frontend file moves off line one and is read
correctly — `{ run: true, why: "apps/frontend/scripts/check-public-env.mjs is under
apps/frontend/" }` — which pins the fault to the **first line only**.

**The conditions are narrow and ordinary:** the change is uncommitted and unstaged (a staged file
prints `M ` with no leading space, an untracked one `??`), and its path sorts first among the
changed paths. All four `PATHS` prefixes are destroyed by losing one character, so any of them can
be missed this way.

**What makes it worse than an ordinary off-by-one is where it lands.** The gate's own docstring
says it is *"wider than CI in one direction, on purpose: uncommitted work counts too"* — that
width is the entire reason to run the gate before committing rather than letting CI decide. The bug
disables precisely that one advantage, and it does so silently, in the direction of skipping.

**Not fixed in that pull request, on instruction — that task was to measure.** Recorded so the fix
would be a decision rather than a discovery, and so that nobody re-derives the measurement.

**Closed on 2026-09-09.** `git()` no longer normalises what it returns; the porcelain read is
parsed by `dirtyPaths()`, which takes a `cwd` so it can be exercised against a purpose-built
repository — the seam where the defect lived, and the only place a test could have caught it. Three
tests in `apps/backend/src/common/gate-porcelain.spec.ts` fail when the `trim()` alone is put back,
naming the mangled path each time.

**And the search for a third instance, which the Founder asked for, found one.**
`scripts/preflight-deploy.js` had grown the identical pairing — a single trimming `git()` helper
used on `git status --porcelain` — independently. There it was harmless, because that script only
counts the lines and prints them, so the corruption cost one misaligned character in a failure
message and never changed an answer. It is separated into `git()` and `gitRaw()` anyway: the two
uses are one edit apart, and the next person to add `line.slice(3)` there would have inherited the
bug rather than written it.

**The correction worth keeping is about the cause, not the count.** This defect was not, as first
believed, a second sighting of something already found and fixed elsewhere. The earlier incident
(#83) was a different class in a different file — `err.stdout ?? "{}"` failing to treat the empty
string as present — and it is already recorded in `CLAUDE.md`. What the two share is only the
shape of the mistake: **a helper that normalises command output, used on output where the exact
bytes are the meaning.** That is the thing to look for, and looking for it is what turned up the
third caller.

### What this changes about the options above

Nothing about their prices, and one thing about their claims. **Option 2 — "the gate derives itself
from the workflow" — was credited with making drift impossible.** It already does that for the
`PATHS` list, and today's divergence happened anyway. A shared list is necessary and not sufficient;
two implementations of the same rule can agree on every input and still be handed different inputs.

**The trigger stays as written — the next step added to `ci.yml`** — and gains a second: **the first
time the gate and CI disagree about whether a conditional check applies.** That has now happened
once, harmlessly, and it is the cheapest moment to look, because the disagreement is visible in two
logs side by side.

---

## Re-costed on 2026-09-13, and Rejected

Re-opened for costing under ADR-087's rule — *a deferred option's price is not a constant, and what
makes it cheaper is usually work done for something else*. The options did get cheaper. **The
decision still went the other way, because the one thing this document never costed was the
problem.**

### What the month made cheaper, counted rather than asserted

| piece an option needed | state on 2026-09-13 |
|---|---|
| read a list out of a workflow file | **built and proven** — `e2ePathPrefixes()`, **12 lines**, reading `PATHS` out of `e2e.yml`, in use since #177 |
| get at the gate's own step list | **built** — `gate.js` exports `STEPS` and five other seams |
| a harness that tests gate tooling against a known-bad input | **built** — `gate-porcelain.spec.ts` constructs a real git repository per case |
| the pattern of deriving a list from the system of record instead of copying it | **built** — ADR-082's `information_schema` sweep |

So **Option 1** lost roughly half its price: what remains is a `ci.yml` parser of the same shape as
the twelve-line one already running, plus the skip list, plus a test. **Option 2's** "read the
workflow" half is no longer a proposal, it is a function with a week of service. **Option 3** is
unchanged — it is a workflow restructure, and the 2026-09-04 decision that put the dependency audit
last still depends on per-step reporting. **Option 4** is unchanged.

### The lists agree today, checked with a parser rather than by eye

Stated because a decision not to build a comparison should at least know what the comparison would
have said. `ci.yml` has **twelve** `run:` steps; one — "Compose Stripe and Resend CI
placeholders" — is the documented exception, and the remaining eleven match `gate.js`'s `STEPS`
one for one, in order, with the browser suite from `e2e.yml` as the twelfth. No drift, seven days
in.

### What was never costed, and it decides this

**The defect cannot let anything through.** Verified rather than assumed:

- `pnpm run gate` appears **once** in the repository, as a `package.json` script. It is not called
  by `ci.yml`, not by `e2e.yml`, and there are **no git hooks at all** — no `.husky`, nothing
  installed in `.git/hooks`.
- So CI never consults the gate. Every `run:` step in `ci.yml` executes on the runner whether or not
  `gate.js` has heard of it.

Which makes the whole failure mode this document was written about:

> the gate reports green, CI reports red on the new step, the developer sees it within one round
> trip — **2m40s**, measured on this week's own runs — and the fix is the one thing they were
> already going to do.

It is **loud, bounded, and self-correcting.** That is categorically different from every invariant
this project has built, each of which guards a failure that announces nothing: a permission matrix
silently granting the wrong rights, two copies of the rules answering the same question differently,
a document version standing still, a cross-Organization leak. **Those are checks because nothing
else would ever say. This one has CI saying it, every time, by construction.**

A mechanism here would buy minutes, and it would cost a parser we wrote — which `CLAUDE.md` records
errs in its own favour and quietly — plus a skip list, which this repository has watched rot twice.
**Spending a silent-failure-prone guard to prevent a loud, cheap failure is a trade in the wrong
direction.**

### The argument for closing that does NOT work, stated because it was the tempting one

*"Two weeks and no step was added, so the hazard is not real."* Measured, it is **seven** days —
`gate.js` landed 2026-09-06 — and the historical rate makes that silence unremarkable:

```
step-additions to ci.yml, excluding the Sprint-0 scaffold:  6 over 33 days
                                            -> one per 5.5 days
P(zero additions in 7 days at that rate)    = 28%
```

**Twenty-eight percent is noise, not evidence.** This is ADR-083's own lesson arriving from the
other side: there, thirteen runs were shown to prove nothing about a defect's absence; here, a week
of quiet proves nothing about a hazard's absence. The hazard is live and will fire, probably within
days. It is being rejected **on its consequence, not on its likelihood**, and those are different
arguments that reach the same place only by accident.

### One thing was done instead, and it is not a mechanism

The person who adds a step to `ci.yml` is the only person positioned to keep the two lists together,
and at the moment they are editing they cannot see the other list. So `ci.yml` now names it, at the
top of its step list, and says what happens if they forget. That is Option 4 — a habit — moved from
a PR checklist nobody reads to the file being edited. **It is a prompt, not a guarantee, and calling
it anything else would be the false confidence this document was written to avoid.**

### A claim inside `gate.js` was wrong, and is corrected

Its `STEPS` docstring said: *"if the two lists are ever compared mechanically (ADR-077 records the
options), **the name is the key that comparison uses**."* That is the implementation the Founder's
own falsification rules out — **a name-keyed comparison passes a renamed step straight through**,
and it would also miss a step whose name held still while its `run:` changed, which is the case that
actually alters what CI executes. The key would have to be the command. Corrected in place so that
whoever reopens this does not inherit the wrong design from the file they are about to change.

### What would reopen it

The old trigger — *the next step added to `ci.yml`* — is kept as a **prompt to re-read this
section**, not as a reason to build. What would actually overturn the decision is the premise
failing:

1. **The gate stops being advisory.** If `pnpm run gate` is ever called by CI, by a git hook, or by
   a deploy script, then its completeness becomes load-bearing and the failure stops being loud.
   This is the one worth watching, because it would arrive as a convenience.
2. **Drift survives a round trip.** If the two lists are ever found to have disagreed for more than
   one pull request — meaning somebody saw CI fail on a step the gate lacked and did not wire it —
   then the correction is not self-executing after all.
3. **A second conditional check.** `browser-e2e` is the only step with a condition, and its
   condition is read from `e2e.yml` rather than copied. A second one would create a second pair of
   conditions to keep in agreement, and #189 already showed that agreeing lists can still produce
   disagreeing answers.
