---
title: OPEN_CONDITIONS
version: 1.2.0
status: Active
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# OPEN CONDITIONS

> "A condition nobody wrote down cannot go stale, because it was never fixed to a date. It also
> cannot be checked, because nobody can say what exactly was claimed."

**What this file is.** Every condition that is true *for now* and that something else waits on. One
row each: what is true, since when, what closes it, who owns the answer, and what it gates.

**Why it exists.** ADR-078 examined a class this project has paid for repeatedly — a claim about a
temporary state, written in the present tense, with no date and nothing that makes its expiry
visible — and concluded that **no mechanism reliably separates a temporary claim from a permanent
one**. Its recommendation was a register like this one, *deferred* on the grounds that only two
such conditions existed and a file for two rows is ceremony. **That recommendation was overturned
the same day it was written**, by a third condition that is more expensive than the first two
together and was recorded nowhere at all: the cost and duration of registering a UAB, on which the
entire path to the first customer depends.

**What this file changes.** Not the forgetting — nothing here prevents somebody writing a temporary
fact inline instead of adding a row. What it changes is the **cost of re-reading**: "check every
present-tense claim" is unbounded work across 13,000 lines of documentation; this is one short list
whose staleness is visible at a glance, because every row carries a date and an empty answer field.

**What belongs here.** A condition external or operational in nature, whose ending no code change
signals — a regulator's answer, a vendor's status, a registration, an unmade decision, an
unperformed one-click action. **What does not belong:** anything a code change corrects, because
that is corrected by ordinary review and would drown this list at roughly six to one (measured in
ADR-078).

**How to use it in prose.** Reference the id — *"blocked on OC-1"* — rather than restating the
condition inline. A restated condition is a second copy that goes stale on its own.

**Not checked by anything.** ADR-078 costed a CI check that reports rows older than N days and
never fails the build; it is not built, and this file is not enforced by the gate. It is read
because somebody opens it, and its rows are short enough that opening it is cheap. Said plainly so
nobody mistakes this for a mechanism.

---

## OC-1 — The cost and duration of registering a UAB

| | |
|---|---|
| **Question** | What does it cost, and how long does it take, to register a UAB in Lithuania — **electronically, with standard articles of association**? |
| **Status** | **Answered on the main question, 2026-09-09, by the Founder. Narrowed, not closed** — one figure and one source remain open, below. |
| **Open since** | 2026-09-07 (recorded; the underlying question is older and was never written down) |
| **Answered** | 2026-09-09, by the Founder. **The estimate was wrong by an order of magnitude.** |
| **Source of the answer** | **Search, not Registrų centras.** The call has not happened, and that is deliberately recorded rather than glossed — see *What is still not confirmed*. |
| **What it gates** | `[LEGAL ENTITY]` placeholders in the customer-facing texts → publishing the Terms and Privacy Policy → lifting the registration gate (ADR-055) → **the pilot**. Unchanged; what changed is how long that chain is. |
| **Owner** | Founder |

### The answer

| | |
|---|---|
| Registering the UAB electronically | **€14.02** |
| Reserving the name beforehand | **€14.79**, and **optional** |
| Elapsed time | **1 working day** |
| Notary | **Not required** — with model articles of association and a qualified e-signature |
| Minimum share capital | **€1,000** — lowered from €2,500 in 2023 |
| Paying the capital | In parts: an initial contribution of **at least 25% of each founder's nominal**, with the total not below the minimum |

**The share capital is not a cost.** It is transferred to the company's own account and stays there
— the company's money, spendable on the company's expenses. Any comparison of "what it costs" that
puts €1,000 next to €14.02 is adding two different kinds of number.

**So the honest total is about €29 of fees and one working day**, plus a transfer from one of the
Founder's accounts to another of the Founder's accounts.

### What this replaces, stated plainly

The estimate in circulation was **three months and thousands of euros**. It appears in no document,
no code comment, and none of ~180 pull requests' commit messages — established on 2026-09-07 by
exhaustive search. **It was wrong by roughly two orders of magnitude in money and by a factor of
about sixty in time**, and it went unchecked for weeks while it was the single most expensive
assumption in the project.

That is the finding worth keeping, and it is not "the Founder was mistaken". It is that **the
project's most load-bearing number was the one number nobody had written down**, so nothing could
go stale, nothing could be reviewed, and its cost was paid in sequencing rather than in euros —
Sprint 15 spent five slices on branch 1 while branch 2 waited on it. This file exists because of
that, and this row is its first return.

### What it confirmed: sub-question 5, and it was the expensive one

The original row broke the question into five, and named the fifth as the one that could move the
whole schedule: **the estimate may have been made about Model B, while the pilot runs on Model A.**

**Confirmed: it was.** ADR-053 already settled the asymmetry — under Model A tips are distributed
by the employer, the restaurant is the tax agent, and the position is answered; it is **Model B**
whose money fork waits on a regulator's written answer (**OC-4**). The three-month figure described
Model B's requirements.

**So the branch that was blocked was not the branch the pilot needs.** That is the sentence to keep.
The roadmap's branch 2 was sequenced behind a number that belonged to branch 3, and no reading of
either branch's contents would have revealed it — only asking what the estimate was *about*.

### What is still not confirmed

**Everything above comes from search, not from Registrų centras.** The figures are consistent and
specific, which is not the same as sourced. They are recorded as the Founder's finding of
2026-09-09, and one call replaces "found" with "confirmed".

**The one figure that genuinely matters is how much capital must be paid before filing**, because
the two rules as recorded can be read two ways and the readings differ by €750:

- **25% of the nominal** — with authorised capital set at €1,000, that is **€250** before filing.
- **Not less than the statutory minimum** — that is **€1,000** before filing, and the 25% relief
  only begins to mean anything above €4,000 of nominal, where 25% first exceeds the minimum.

Both readings are consistent with the two sentences as written; they cannot both be right. **This
is a question with a numeric answer, which makes it a good one to put to the registrar** — along
with whether the €14.02 covers everything or is one line of several.

### The three sub-questions this did not touch

Sub-question 1 is answered. Sub-question 4 is **OC-4**. Sub-questions 2 and 3 are untouched by any
of the above, and one of them was described in this very row as *"usually the longest step"*:

- **Opening a bank account for the new company.** Not measured. Sensitive to the founder's
  residency, and the company's capital has to be paid into it, so it sits *between* registration
  and everything else.
- **Stripe accepting a live account on a Lithuanian legal entity.** Not measured, and it is a
  question for Stripe rather than the registrar. The pilot takes real card payments, so this is on
  the critical path, not beside it.

**Neither is a reason to doubt the finding**, and both are reasons not to convert "one working day"
into "the pilot is one working day away". The registration has stopped being the long pole. Writing
and publishing the texts is now the long pole, and these two are unmeasured.

---

## OC-2 — There is no customer data yet

| | |
|---|---|
| **Status** | Open — true today. |
| **Open since** | project start |
| **What closes it** | The first real pilot restaurant taking a real payment. |
| **What it gates** | It is the **surviving** reason to defer the staging environment (ADR-035, as amended) and part of the case for deferring the off-platform database backup. |
| **Owner** | Nobody — it closes by itself, on the trigger. |

The unusual property worth noting: this condition **expires exactly when the thing it defers
becomes necessary**. That is what makes the deferral honest rather than indefinite — the day a
pilot restaurant arrives is the day staging stops being premature.

---

## OC-3 — `browser-e2e` is not a required status check on `main`

| | |
|---|---|
| **Status** | Open. |
| **Open since** | 2026-09-05 (ADR-073's option A′ landed in #166; the branch-protection step was deliberately left as the last step, to be done by hand) |
| **What closes it** | Settings → Branches → the `main` rule → *Require status checks to pass before merging* → add `browser-e2e` → Save. |
| **What it gates** | Nothing is blocked. The browser suite runs and reports on every pull request, and its result is **advisory**: a red browser run does not prevent a merge. |
| **Owner** | Founder — this cannot be done from the CLI (the branch-protection API call is refused in this environment). |

ADR-073 exists because a check that does not run reports nothing, and nothing reads as green. The
workflow was reshaped so that `browser-e2e` always reports — skipped or otherwise — precisely so it
*could* be made required without permanently blocking documentation-only pull requests. **The
mechanism has been ready since #166; the click has not happened.** It has been raised in five
consecutive reports, which is itself the argument for a register rather than a repeated paragraph.

---

## OC-4 — Two regulator requests are outstanding

| | |
|---|---|
| **Status** | Open. Sent, unanswered. |
| **Open since** | recorded in ADR-053 (Sprint 14) |
| **What closes it** | A written answer from **VMI** (who is the tax agent when a platform moves money from a customer directly to a named individual) and from the **Bank of Lithuania's Newcomer Programme** (whether initiating transfers to natural persons changes what the platform is doing, in the regulatory sense). |
| **What it gates** | Everything in Model B: the money fork, the tax figure on staff earnings exports (ADR-067 deliberately ships no tax column), and the waiter's wallet. **Not** the pilot, which runs on Model A. |
| **Owner** | Founder |

**Added beyond the brief**, and flagged rather than slipped in: the Founder's instruction named
OC-1 and two rows from an earlier count. This is a fourth, included because branch 3 of the roadmap
is *defined* as "waiting on the regulator" and a register that omits the thing branch 3 waits on
would be incomplete on its first day. Remove it if that is not wanted.

---

## OC-5 — The Stripe-agreement route is protected only transitively

| | |
|---|---|
| **Status** | Open. Not a defect today; a defect on a specific future date. |
| **Open since** | 2026-09-08 (when `POST /restaurants` began writing a `STRIPE_CONNECTED_ACCOUNT` acceptance) |
| **What closes it** | Publishing the platform terms — which is also **what makes it dangerous**. See below. |
| **Owner** | Founder |

`POST /restaurants` now records the Stripe connected-account agreement (ADR-049), and
`CURRENT_STRIPE_AGREEMENT_VERSION` is still the placeholder `UNPUBLISHED-no-terms-document-exists-yet`.
By ADR-055's own reasoning that row would be a **false** record — asserting a business agreed to a
document nobody can produce — and ADR-055 exists because a gate written about a *screen* protected
nothing while the route kept writing.

**This route has no gate. It does not need one today**, because the path is closed one step
earlier: `assertPlatformTermsPublished` refuses `POST /auth/register` in production, nobody can
create a restaurant without an account, and so no false row is reachable.

**The trigger is the unusual part and the reason this is a row rather than a comment.** The
condition ends when the platform terms are published — and that is the exact moment the transitive
protection disappears: registration opens, real people create restaurants, and the Stripe constant
may still be a placeholder if the second document is published later than the first. **The
protection and the danger have the same trigger.**

Three options, costed in `UX_MAP.md` and not decided: extend the existing gate to this route (its
message says *"Registration is not open yet"* — wrong words here), write a sibling gate with its
own wording, or keep the reliance and accept that publishing one document without the other opens
the hole. **Whoever publishes the platform terms must read this row on the same day.**

---

## Closed conditions

Kept rather than deleted: how a condition ended is the part that teaches, and an empty history here
would make the file look like it has never been wrong.

| Condition | Opened | Closed | How it ended |
|---|---|---|---|
| Stripe integration non-functional against `invalid_v2_key` | 2026-08-24 (written) | **2026-08-30** (key replaced in Railway) | A `STRIPE_SECRET_KEY` truncated by one character (ADR-038). **Nothing re-read the two documents asserting it**, so the claim stood in the present tense for fourteen days and was repeated as current in a pull-request report. Closed by execution on 2026-09-07: `POST /restaurants` returns 201 with a real connected account. This is the incident that produced ADR-078 and this file. |
