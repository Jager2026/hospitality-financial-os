---
title: ADR-078 — A claim about a temporary state is written in the present tense and never expires
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-078 — A claim about a temporary state is written in the present tense and never expires

**Status:** Proposed (Sprint 15), 2026-09-07. **Options only, nothing built.** The Founder asked
for an assessment rather than a mechanism, and the assessment's conclusion is that no mechanism
reliably separates a temporary claim from a permanent one — so what follows is an honest map of
what is and is not available, with the one part that needs no classification identified.

---

## The class, from two measured instances

Both have the same shape: **a statement about a state that will change, written in the present
tense, carrying neither a date nor anything that would make its expiry visible.**

| Claim | Written | Stopped being true | Noticed | Cost |
|---|---|---|---|---|
| *"Stripe integration is currently non-functional (`invalid_v2_key`, open with Stripe support)"* — `IMPLEMENTATION_PLAN.md` and ADR-035, twice | 2026-08-24 | 2026-08-30 | 2026-09-07, by execution | a screen slice reported as blocked when it was not; a deferral resting on a dead reason |
| *"nothing in this codebase runs it automatically"* — the seed line | Sprint 12 | when CI began running it | during a documented sweep | recorded in the #157 diagnostic block |

The Stripe instance has a detail worth keeping: **the same document set contradicted itself two
days later.** ADR-038 recorded the root cause — a `STRIPE_SECRET_KEY` truncated by one character —
on 2026-08-26, and never said whether the fix had been applied. So a reader had one document
asserting an outage in the present tense and another explaining its cause in the past tense, both
authoritative, neither dated. The claim outlived its truth by **fourteen days** and was then
repeated as current in a pull-request report, because that is what the plan said.

**Why re-reading does not happen, stated mechanically rather than as a failing of attention.** The
person who ends the condition is not the person who wrote the sentence, is not working in that
file, and has no reason to open it. Nothing about fixing a key in Railway leads anyone to a
paragraph about staging. The trigger for re-reading is absent by construction, and the work is
unbounded: "check every present-tense claim" is 13,000 lines across 29 documents.

---

## The Founder's candidate, and the objection he raised himself

> A claim about current state carries a date and what would end it. Then "re-read" becomes "see
> something expired."
>
> The problem I see: a machine cannot tell a temporary claim from a permanent one. So either
> manual marking — which will be forgotten — or a heuristic on words like *currently*, which will
> be evaded without anyone meaning to.

The objection is correct. **It is also separable, and that is the most useful thing in this
document:** the candidate has two halves, and only one of them needs the classification.

- **Writing "as of 2026-08-24" needs no classification at all.** A permanent fact is not harmed by
  carrying a date — it merely looks redundant. Anyone can apply the convention without deciding
  whether their sentence is temporary, which is exactly the decision that cannot be automated.
- **Flagging an expired claim automatically does need it.** That is where every option below either
  gets noisy or gets forgotten.

---

## The heuristic, measured rather than estimated

A keyword check would key on words like *currently*, *at present*, *for now*, *is not yet*. Counted
across `docs/`:

| Term | Occurrences |
|---|---|
| `currently` | 47 |
| `for now` | 7 |
| `is not yet` / `does not yet` | 6 |
| `at present` | 0 |

**Of the 47 uses of *currently*, roughly six to eight are claims of this class** — an external or
operational state that no code change corrects: the Stripe outage (twice), "currently the only
backup mechanism", "currently runs a single instance", "currently bills around $1.83/month",
"currently green". The other ~40 describe how the code or schema currently reads, which changes
*with* the code and is corrected by ordinary review.

So a check reporting every hit would be **roughly 85% noise**, and the standard remedy — an
allowlist for the 40 — is precisely the structure this project has watched decay twice
(`test/global-setup.ts`'s permission matrix, the audit ignore list). A gate people learn to skip is
worse than no gate.

**And the decisive measurement: the keyword heuristic would have caught two of this incident's
three lines.** `IMPLEMENTATION_PLAN.md:298` and ADR-035's "Why this is decided now" both say
*currently*. ADR-035's Decision 4 says *"the very sandbox whose `invalid_v2_key` failure this
project is actively diagnosing with Stripe support"* — no keyword, same staleness, and the miss
would have been silent. A checker that finds most of an incident and reports nothing about the rest
teaches the reader that a clean run means clean.

---

## Options

### A — Nothing mechanical; this ADR and a writing convention

**Price:** it is a habit, and this project has written down twice that a check living in a habit
stops the day the habit does. **Buys:** nothing to build, nothing to maintain, and no false
confidence from an instrument nobody re-verified. **Would it have caught this?** No.

### B — Keyword lint over `docs/`

**Price:** measured above — ~85% noise, an allowlist that decays, and silent misses on any sentence
that states a temporary fact in plain words. **Buys:** zero authoring cost; nobody has to remember
anything. **Would it have caught this?** Two of three lines, with the third missed silently.

### C — An explicit dated marker, reported (never failed) by CI

`*(as of 2026-08-24)*` inline, or a comment carrying an expiry condition; a script reports any
as-of date older than N days. **Price:** manual marking, forgotten exactly as the Founder says.
**Buys:** one property the others lack — **it cannot make things worse.** An unmarked claim is
exactly as bad as today; a marked one is strictly better. Failure is a missing improvement, never a
new defect. **Would it have caught this?** Only if the author had marked it. The author was this
session, on 2026-08-24, and did not.

### D — A register of open conditions, referenced instead of asserted

One short file — say `docs/OPEN_CONDITIONS.md` — with a row per temporary condition: what is true,
since when, what closes it, who owns it. Prose then *references* it ("blocked on OC-3") instead of
restating the state inline.

**Price:** an indirection when writing, and the register can itself go stale. **Buys — and this is
the real argument:** it changes what re-reading costs. Today "re-read every present-tense claim" is
unbounded work across 29 documents; with a register it is one file of perhaps six rows whose entire
purpose is to be re-read, and whose staleness is visible at a glance because every row carries a
date. A stale row that says *open, since 24 August* is loud; a stale sentence in a paragraph is
invisible. **Would it have caught this?** Probably — "blocked on Stripe" is exactly the kind of
thing someone opens a register for, and 30 August is exactly when they would look at it. Not
certain, because the same forgetting applies to creating the row in the first place.

### E — Prefer a pointer to a live signal over a transcribed status

Not a checker: a writing rule. Where a live signal exists, reference it instead of copying its
current value into prose. The Stripe case had one — ADR-038's own boot-time liveness probe answers
*does this credential work*, continuously, in production. Had the plan said "see the Stripe
liveness probe" rather than "currently non-functional", there would have been nothing to go stale.

**Price:** only applies where a signal exists, which is a minority of cases — nothing observes "the
Stripe ticket is open" or "there is no customer data yet". **Buys:** it removes the class where it
applies, rather than detecting it afterwards. **Would it have caught this?** Yes, for this
instance specifically.

---

## Assessment

**There is no mechanism that reliably separates a temporary claim from a permanent one**, and this
is stated plainly rather than worked around: every option is either manual and forgettable, or
automatic and either noisy or evadable. Anyone proposing otherwise should be asked for the false-
positive count first — the measurement above took ten minutes and refutes the most obvious design.

What is available is weaker and still worth something, in this order:

1. **The convention half of the Founder's candidate — write the date — because it needs no
   classification.** "As of 2026-08-24" costs three words and converts an assertion into an
   observation. A reader who sees a two-week-old *as of* treats it differently from an undated
   *currently*, with no machine involved. This document, ADR-035's amendment and the plan entry now
   do it; whether it becomes a rule is the Founder's to say.
2. **E, where a live signal exists** — the only option that removes rather than detects.
3. **D, as the cheapest thing that changes re-reading from unbounded to one short file.**

**Recommended and not acted on: 1 and 2 as writing rules, D deferred until there are enough open
conditions to justify a file** — with two known today (there is no customer data yet; `browser-e2e`
is not a required check), a register would be a ceremony around two rows.

**Explicitly rejected: B.** Not because heuristics are impure, but because the number was measured
and it is 85% noise with a silent miss on this very incident.

**Trigger for revisiting: the third instance of this class.** Two are a pattern; three would mean
the convention is not holding, and D's cost stops looking like ceremony.
