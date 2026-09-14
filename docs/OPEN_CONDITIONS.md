---
title: OPEN_CONDITIONS
version: 1.8.0
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

**The form of a trigger: it goes on the PRECONDITION, never on the occurrence.** *"The first
dispute"* is a useless trigger, because a dispute is the very thing that produces the wrong data —
by the time it fires, the row it was supposed to protect already exists and the cost is already
paid. *"The first venue taking real traffic"* is the same condition moved one step earlier, to
before a dispute is possible at all. Every row below states its trigger in that form, and a row
whose trigger names the event it is meant to survive is written wrong and should be rewritten
rather than kept.

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

**The call is to Registrų centras, 8 700 55 000.** Recorded as a number rather than as "a call to
the registrar", because a task without a phone number in it is a task that stays a sentence. Two
questions, both with numeric answers: how much capital must be paid before filing, and whether
€14.02 is the whole fee.

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

### Somebody is already running Model B in Lithuania — established 2026-09-09

**This does not answer either question above, and it is recorded here because it is the closest
thing to evidence that has appeared while they go unanswered.**

**GlobalTips Europe, UAB** — a Lithuanian legal entity, registration code **305942984**, Naugarduko
g. 3-401, Vilnius. From its own public documentation:

- it **"is not a financial organisation"**;
- the employee opens an account with its **banking partner, Stripe**, and submits a photograph of an
  identity document *there*;
- tips accumulate as a **balance**, withdrawable to an IBAN in **up to 3 business days**, or
  **instantly for a small fee**.

### What that description resolves to, read as an implementation

The four statements only fit together one way. **"A balance in the app" is the waiter's own Stripe
connected-account balance**, and **"instant withdrawal for a small fee" is Stripe Instant Payouts** —
Stripe's product, and Stripe's fee, surfaced under someone else's brand. The platform does not hold
the money, which is exactly what lets it say it is not a financial organisation.

**That is Model B (ADR-053), seen from the waiter's side.** The tip separates at payment and lands
in the person's own account; the venue never receives it, holds it, or distributes it.

**It matches ADR-061 on the part that decision had to guess at**: one person, one connected account,
identity verified at Stripe rather than at the platform, with payouts a separate capability from
receiving. The onboarding this project designed against Stripe's test API is the onboarding a
company in the same jurisdiction is running in production.

**And it is a point in favour of `Wallet` being a projection rather than a store** (ADR-006,
`DATABASE.md`). Under Model B the authoritative balance is Stripe's; a `Wallet` that *stored* money
would be a second ledger of the same euros, disagreeing with Stripe the moment a payout settles. A
projection over `LedgerLine` **shows** the obligation without **holding** it — which is why ADR-053
could observe that the `tip_payable` line is identical under both models. The screen survives the
switch from A to B; only settlement changes.

### The boundaries of this fact, which are most of it

**The source is a company's own public documentation. It is not a regulator's position, and it is
not an audit.** Everything above is what GlobalTips says about GlobalTips.

- **"Not a financial organisation" is their claim about themselves**, not a determination by the
  Bank of Lithuania. It is also precisely the claim this project would need to be true of itself,
  which makes it the least safe sentence to borrow.
- **The corporate structure is unknown.** Whether the Lithuanian UAB is the contracting party for
  the money flow, or a subsidiary of something registered elsewhere, was not established.
- **A company operating this way is not evidence that it is compliant.** It is evidence that the
  shape is being run, that Stripe supports it for Lithuanian individuals, and that somebody has
  concluded the risk is acceptable. Those are three useful facts and none of them is the answer
  **OC-4** is waiting for.

### Their tax claim is the VMI question, and it stays a claim

**They state that the employer pays no additional taxes on tips.** That is not a detail — it is
*the* question put to VMI, almost word for word: who is the tax agent when a platform moves money
from a customer directly to a named individual.

**Recorded as somebody else's assertion, deliberately, and it changes nothing about this row's
status.** A competitor's reading of Lithuanian tax law is not a written answer from VMI, and
treating it as one would be the same error as the estimate in **OC-1** — a number that governed the
schedule because it was repeated confidently and never sourced. ADR-067 continues to ship no tax
column on staff-earnings exports, for exactly the reason it always did.

**What it does change: the question is worth asking with more urgency, and with a sharper form.**
Somebody has an operating answer. The useful version of the VMI request is no longer only "what is
the rule" but "a Lithuanian platform is doing X and telling employers Y — is that right", which is a
question a regulator can answer briefly.

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

## OC-6 — The V2 landing imagery carries third-party marks, and its palette is not the system's

| | |
|---|---|
| **Status** | Open. **Gates nothing today**, and that is measured rather than assumed — see below. |
| **Open since** | 2026-09-13 (when `PlainTabs Landing V2.html`, a Claude Design export, was reviewed) |
| **What closes it** | **Our own photography.** Not a crop, not a retouch, not a different generation — frames this project shot and owns. |
| **Owner** | Founder |
| **What it gates** | Nothing yet. It becomes blocking the moment any of those frames is proposed for the landing, the pitch deck, or an investor presentation. |

### The marks

Two of the frames carry marks that are not ours:

- **"Verifone"**, legible on a payment terminal in close-up. Verifone is a live manufacturer of
  payment terminals — **a direct competitor on hardware**, which is the worst possible logo to put
  on the device in our own marketing.
- **"BRÜKKE"**, invented, on another frame. Nobody's mark, which is a different problem and a
  smaller one: it is a fictitious business presented as a customer.

### Why this is a written row and not a check, stated because the instinct is to build one

**The marks are inside the pixels.** Measured on the file: **nine** `<img>` elements, **every one
with `alt=""`**, each `src` a bare UUID rather than a filename. Searching the file for `Verifone`
returns **zero** — and it would return zero for any competitor's name, any trademark, any legible
text in any frame.

So no lint rule, no invariant and no CI check this project could write would ever see this. **A
person looking at the picture is the only detector there is**, which is exactly the class
`OPEN_CONDITIONS.md` exists for: a condition no code change can signal.

### It gates nothing today, verified rather than asserted

Neither the file nor any of its asset ids appears anywhere in the working tree — checked across the
repository, not only in `apps/frontend/`. The frames are used in no landing, no deck and no investor
material. **This row exists so that stays true on purpose rather than by nobody having got round to
it.**

### The palette — and it is worse than "different numbers"

The file does not carry *a different* palette. It carries **the real one with invented steps mixed
into it**, and several of the invented steps are one or two hex digits away from a real token:

| in the file | in `tokens.css` | |
|---|---|---|
| `#161615`, `#FFE500`, `#EFECE4`, `#ECEBE7`, `#0F0E0C`, `#F4F3F0`, `#726D64` | the same values | **genuine tokens** |
| `#0E0E0D` | `#0F0E0C` (`--n-950`) | one digit in R, one in B |
| `#F5F4F0` | `#F4F3F0` (`--n-50`) | one digit in R, one in G |
| `#5F5D56` | `#5C5852` (`--n-600`) | near |
| `#FF8A80` | `#FF8A7A` (`--error`) | **four of six digits identical** |
| `#6FBF87` | `#7BD68F` (`--success`) | near |
| `#141312`, `#E4E2DD`, `#D8D5CF`, `#FAFAF8`, `#D9D5CB`, `#928D84` | — | no counterpart at all |

**That mixture is the hazard.** A reader spot-checking two or three values would find them correct
and conclude the file is authoritative. `#726D64` in particular *is* `--n-500`, so the one value
most likely to be checked is the one that passes.

### What adopting two of them would cost, measured

`--text-muted` is `#726D64` on the guest terminal, and `tokens.css` records its own floor: it clears
4.5 on `--surface` (`#F4F3F0`) at **4.63**, and on the next step down (`#ECEBE7`) it is **4.31** and
fails. Two of the invented surfaces sit below that step:

```
#726D64 on #F5F4F0  = 4.67   passes
#726D64 on #E4E2DD  = 3.97   FAILS the 4.5 floor
#726D64 on #D8D5CF  = 3.51   FAILS the 4.5 floor
```

**The calculator was checked against answers already written down** before it was believed — it
reproduces `tokens.css`'s own 4.63, 4.31 and 5.14 exactly. So this is not a difference of taste:
adopting those two surfaces would silently break an accessibility floor that
`tokens.contrast.spec.ts` asserts, on the one screen a stranger has to read in ten seconds.

### The rule

**There is one source of colour: `apps/frontend/src/styles/tokens.css`.** The ladder was derived in
[ADR-072](adr/ADR-072-the-portal-is-dark.md) and is asserted by
`tokens.contrast.spec.ts`. **Numbers from that file are not to be taken** — not into the landing,
not into a deck, not as "close enough" for a mockup, because a mockup is where a value gets copied
from.

---

## OC-7 — The dispute handler's `default` branch acknowledges what it does not recognise

| | |
|---|---|
| **Status** | Open. Measured, not inferred: delivered against the real database on 2026-09-13 (ADR-090, ADR-091). |
| **Open since** | 2026-09-13 |
| **What closes it** | An **enumerated list of deliberately-ignored event types**, so that anything outside it is logged as *unknown* instead of silently joining the ignored. |
| **Owner** | AI Technical Co-Founder |
| **What it gates** | Nothing today. It gates the correctness of the first handler somebody writes for an event type Stripe adds later. |
| **Trigger** | **The first venue taking real traffic** — before a dispute is possible. |

`charge.dispute.updated` and `charge.dispute.funds_withdrawn` fall to `default`: logged at debug,
claim marked `COMPLETED`, Ledger untouched. For those two that is the intended behaviour. The
problem is that it is also the behaviour for **every event type that does not exist yet** — a new
one is treated as handled the first time it arrives, and nothing anywhere says it was not.

The mechanism is not a handler per type; it is a list. Naming the ignored types costs a few lines
and converts silence into a signal. It is a row rather than an edit because deciding *which* types
are deliberately ignored is a judgment about the integration, not a refactor.

---

## OC-8 — `createPaymentIntent` sends no idempotency key to Stripe

| | |
|---|---|
| **Status** | Open. Measured 2026-09-13 (ADR-089): request options carry only `{ stripeAccount }`. |
| **Open since** | 2026-09-13 |
| **What closes it** | Passing an idempotency key in `StripeService.createPaymentIntent`'s request options. |
| **Owner** | AI Technical Co-Founder |
| **What it gates** | Nothing today, and the reason is measured rather than assumed. |
| **Trigger** | **The first venue taking real traffic.** |

**We demand idempotency of our own callers and offer none to the vendor.** `POST /payments` carries
`IdempotencyInterceptor`, `payment.idempotency_key` is unique — and the outbound call to Stripe has
no key at all. The asymmetry is what makes it harmless today: every retried creation yields a *fresh*
intent id, so a duplicate cannot masquerade as the original, and no path was found that produces two
Payment rows for one intent. That is *not found*, written as the weaker of the two statements.

**The price of fixing this does not grow with time** — it is one argument to one call — which is
exactly why it belongs on a list instead of in a sprint.

---

## OC-9 — Webhook deduplication as a general mechanism is not built, and that is a decision

| | |
|---|---|
| **Status** | Open **by decision**, 2026-09-13. |
| **Open since** | 2026-09-13 |
| **What closes it** | A decision about the shape, taken across all six redelivery cases at once — not adopted from inside one handler. |
| **Owner** | AI Technical Co-Founder |
| **What it gates** | It is the standing reason not to generalise ADR-090's idiom by reflex. |

Six cases, four different guards, and until ADR-090 a sixth guarded by nothing (ADR-089's table).
Picking one shape while looking at one handler means adopting it without having examined the other
five — and the measurement that produced that table corrected two confident readings on the way, so
the survey is not optional.

**This row exists so the absence stays a decision rather than decaying into an assumption.** The
general form of the risk is in `CLAUDE_RULES.md`: coverage accumulated case by case is not a
property of the pipeline, and the next event type inherits zero.

---

## OC-10 — A poller test asserts about the depth of the queue, not about its own events

| | |
|---|---|
| **Status** | Open, 2026-09-13. **It has now cost a red gate and the mechanism is measured** — 2026-09-14, below. |
| **Open since** | 2026-09-13 |
| **What closes it** | Scoping the assertion to the events the test itself created — **isolation, not cleanup**. |
| **Owner** | AI Technical Co-Founder |
| **What it gates** | Nothing in the product. It is a flake source, and flakes are how a suite stops being read. |

Draining the queue makes a run pass; it does not make the assertion true. ADR-086 did the right
thing by excluding money events from the harness sweep, and that is a **different requirement** from
this one: *"do not delete it"* and *"do not let it reach the assertion"* are two rules, and only the
second makes the test independent of whatever else the shared development database happens to hold.

### What it actually costs, measured 2026-09-14

`outbox-poller.service.spec.ts:949` — *"a failing event is not retried immediately, and each gap is
longer than the one before"* — failed with **`expected 1 to be 2`** on a documentation-only branch.
The test's own event was never selected by the third poll.

**The mechanism, and it is sharper than "an accumulated database".** The poller takes
`orderBy: createdAt asc, take: 50`, filtered on `attempts = 0 OR nextAttemptAt <= now()`. The
test's event is the **newest** row in the queue, so it is selected only while fewer than fifty
*older* rows are due. The first poll reached it — `attempts` became 1, and an assertion two lines
earlier would have failed otherwise. The third poll did not, and what happens in between is the
test's own `vi.setSystemTime(Date.now() + firstGap)`: **advancing the clock by the backoff gap pulls
every older row whose retry falls inside that jump into the due set at once**, and they are all
older. The test evicts itself from the batch it is waiting for.

Measured at the moment of the failure: **90 queued, 85 due, batch size 50.** After
`pnpm run db:reset`, the same suite on the same commit was green — a discriminating pair on queue
depth alone, with no code changed between the runs.

**Seven of those rows were money events whose `journal_entry` no longer existed** — litter from
measurement scripts whose teardown deleted the JournalEntry but not the OutboxEvent it produced.
They were marked abandoned with that reason rather than deleted. **The first count of them was 27
and was wrong**: the query matched email events too, which carry no `journalEntryId` at all — a
self-written instrument erring in the direction of finding something, which is the direction
`CLAUDE_RULES.md` warns about.

**None of that changes what closes this row.** Resetting the database made the run pass and left the
assertion exactly as dependent on global queue depth as it was.

---

## OC-11 — The recovery window is three days, and one thing about it is not found

| | |
|---|---|
| **Status** | Open as a **vendor bound**, true today. |
| **Open since** | 2026-09-13 (quoted from Stripe's own documentation in ADR-090) |
| **What closes it** | Nothing closes it. It is a constraint to design against, and it changes only if Stripe changes it. |
| **Owner** | Founder operationally; AI Technical Co-Founder for design. |
| **What it gates** | How long the webhook endpoint may be down before loss becomes permanent. |

> "Stripe attempts to deliver events to your destination for **up to three days** with an exponential
> back off in live mode."

An endpoint down longer than that loses events irrecoverably — there is no catch-up mechanism on our
side, and reconciliation does not cover the gap (**OC-12**).

**Whether Stripe disables an endpoint by itself under sustained failure is NOT FOUND in the
documentation reachable from `stripe docs`.** Recorded as *not found*, never as *does not happen*: a
vendor guarantee holds inside the bounds the vendor states, and this one is unstated.

---

## OC-12 — Reconciliation answers "did it arrive", never "is what arrived correct"

| | |
|---|---|
| **Status** | Open as a **boundary of the mechanism**, not as a defect. 2026-09-13. |
| **Open since** | 2026-09-13 |
| **What closes it** | Nothing. It is recorded so the next audit does not credit it with coverage it does not have. |
| **Owner** | AI Technical Co-Founder |
| **What it gates** | Any claim that reconciliation is a safety net for correctness. |

`PaymentReconciliationService` selects `status = 'PENDING'`. A payment carrying a dispute is
`SUCCEEDED`. A payment captured twice is `SUCCEEDED`. **It never looks at either row at all** — so
for that class it is neither a detector after the fact nor a prevention before it. It is not a
mechanism at all there, which is a sharper statement than "it is late".

And that is what it should be. Reconciliation answers whether a payment that left us reached a
terminal state; a mechanism answering that question cannot also answer whether the terminal state is
right. This row exists because the **name** suggests the wider meaning, and a reader in six months
will take the name at its word.

---

## OC-13 — Where the natural key is issued by a vendor, the constraint was missing

| | |
|---|---|
| **Status** | The three known instances are **closed** (ADR-089). **The regularity is the open part.** |
| **Open since** | 2026-09-13 |
| **What closes it** | Nothing closes it. It is a question to ask of every new table that carries an identifier issued elsewhere. |
| **Owner** | AI Technical Co-Founder |
| **What it gates** | The review of any new table with an external identifier. |

`payment.processor_payment_id`, `refund.processor_refund_id` and `chargeback.processor_dispute_id`
were each the natural key of their row, and not one of the three was unique. Where the key is
**ours** — `payment.idempotency_key`, `transaction.payment_id`, `restaurant.stripe_account_id` — the
constraint was there from the first migration.

**The split is not random, which is what makes it a regularity worth writing down.** A column this
system generates reads as an identity; a column copied out of a vendor's payload reads as data. It
is an identity either way. The check is one line of review: *if a column holds an identifier issued
elsewhere and names exactly one thing, it is unique — or the reason it is not is written next to the
field.* `restaurant.company_number` and `restaurant.vat_number` are the recorded exception, and the
reason sits beside them in `schema.prisma`: one UAB legitimately owns several venues.

---

## OC-14 — The dispute fee leaves the restaurant's balance and nothing records it

| | |
|---|---|
| **Status** | Open, and **reformulated on 2026-09-14** after the measurement in **ADR-092**. |
| **Open since** | 2026-09-13 |
| **What closes it** | An **entry**, not an account: recording that the restaurant's money left. It cannot be written until the fee's amount is available, and that arrives on `charge.dispute.funds_withdrawn` — the event that falls to `default` today (**OC-7**). |
| **Owner** | Founder — it is a question about what this Ledger is for before it is a schema question. |
| **What it gates** | The accuracy of any figure claiming to describe what a venue actually received. |
| **Trigger** | **The first venue taking real traffic** — not the first dispute, which is the event that produces the gap. |

**What the first version of this row got wrong.** It called the dispute fee a platform cost and
asked where a *processor-cost account* should live. That was reasoning rather than measurement.
**ADR-092 established the opposite by reading the configuration the accounts are created with:**
these are direct charges on the restaurant's connected account, `fees_collector` is `stripe`, and
Stripe's own fee-payer table bills the dispute fee to the **connected account**. The disputed
amount, separately, *"Stripe debits […] from the connected account's balance, not your platform's
balance."*

**So the shape is: a missing entry, never a missing account.** The restaurant loses the disputed
amount *plus* the fee; the Ledger records the amount and is silent about the rest. Nothing recorded
is wrong, which is why this is a condition — but the silence is about somebody else's money, which
is a different kind of silence than a cost we forgot to book.

**The size is still unknown**, and unknowable from here: the fee is per-network and per-contract and
this project has never seen a live one. **The blocker is structural rather than commercial** — the
number arrives in a `balance_transaction` on an event we acknowledge and discard, so OC-7 is
upstream of this row.

---

## OC-15 — Three account classes are wrong under direct charges, and the fee is unfetched rather than unseeable

| | |
|---|---|
| **Status** | Open, and **measured on 2026-09-14** rather than argued — see **ADR-093**. The measurement narrowed it: no venue-facing number is wrong, so this is a rename and a decision, not a repair. |
| **Open since** | 2026-09-14 |
| **What closes it** | Two separable things, and the second is now cheap and specific: **(1)** a decision on the three account classes below; **(2)** fetching the fee — `paymentIntents.retrieve(id, { expand: ["latest_charge.balance_transaction"] })` with the `{ stripeAccount }` option, one call, measured returning `fee=63 net=1137`. |
| **Owner** | Founder for (1); AI Technical Co-Founder for (2). |
| **What it gates** | Nothing on screen today. It gates any future claim that a figure shows what a venue *receives*, and the `processingFee` line that currently renders "Not available". |
| **Trigger** | **Before the first report is shown to a venue** — a number is hardest to correct after somebody has read it. |

**Which classes, and what each asserts.** ADR-002 names the chart of accounts with classes that
belong to a platform holding the customer's money:

- `PROCESSOR_CLEARING` (**asset**) — the platform holds nothing; the funds are on the venue's own
  Stripe balance. It is a clearing contra, not a claim on money.
- `RESTAURANT_REVENUE_PAYABLE` (**liability**) — the platform owes nothing; the venue already
  holds it. The figure is the venue's share of the bill.
- `TIP_PAYABLE` (**liability**) — under Model A the employer distributes tips (ADR-053), so the
  entitlement is against the venue, not against us.

`PLATFORM_FEE_REVENUE` (**income**) is the one class that survives: the application fee really does
land on the platform's balance.

**Do the numbers change? No — and that is the finding, not a hope.** Nothing venue-facing reads
`PROCESSOR_CLEARING`; `netRestaurantRevenue` is `credits − debits` of one account and a name is
not an input to arithmetic; the UI labels — *"The restaurant's share"*, *"Before platform fee
deduction"* — are accurate; and `processingFee` renders **"Not available"** rather than a false
zero. **One sentence of prose is the exception:** ADR-025 says that field *"answers 'what does the
restaurant actually keep'"*, and the venue keeps that figure minus its share of Stripe's fee.
Corrected in ADR-025 itself.

**The second half is no longer a philosophical gap.** Two places in the source still say the fee is
something *"this system cannot see"*. Measured: the fee is not in the webhook payload — the event
carries `latest_charge` as a bare id and no Stripe-fee field — and it **is** in the
`BalanceTransaction`, one `expand` away. **Unfetched, not unseeable.** On the measured charge it
was **63 against a platform fee of 10**, so the deduction nobody shows is several times the one that
is announced.

**A constraint for whoever implements (2):** `charge.balance_transaction` came back **null** on a
retrieve immediately after confirmation and populated seconds later, so the fetch belongs on the
Outbox's schedule rather than inside the webhook's own transaction.

**This row stays the general case of which OC-14 is one instance** — the dispute fee is the same
money on the rare path; this is the same money on every payment.

---

## OC-16 — A late win after a lost dispute would be acknowledged and ignored

| | |
|---|---|
| **Status** | Open. Found in Stripe's documentation on 2026-09-14 (ADR-092), not reproduced. |
| **Open since** | 2026-09-14 |
| **What closes it** | Allowing `handleDisputeClosed` to act on a Chargeback that is already `LOST` when the dispute's status comes back `won`. |
| **Owner** | AI Technical Co-Founder |
| **What it gates** | Nothing today. It is one venue's money on a rare path. |
| **Trigger** | **The first venue taking real traffic** — a late win is only possible after a real loss. |

> "Although the outcome of a dispute is normally final, in rare cases the status can change from
> lost to won. When this occurs, Stripe labels the dispute as a **late win** and returns the funds
> to your balance." — `stripe docs /disputes/how-disputes-work`

`handleDisputeClosed` returns early when `chargeback.status !== "UNDER_REVIEW"`. That early return
is the dedup safety net ADR-090 relies on, and it is right for a redelivered `closed`. **It is also
what would swallow a genuine second outcome**, leaving the provisional loss standing against money
that came back. Recorded rather than fixed because the two cases are told apart by the payload's own
status, and separating them is a change to the dispute handler — its own axis, its own pull request.

---

## Closed conditions

Kept rather than deleted: how a condition ended is the part that teaches, and an empty history here
would make the file look like it has never been wrong.

| Condition | Opened | Closed | How it ended |
|---|---|---|---|
| **OC-3** — `browser-e2e` was not a required status check on `main` | 2026-09-05 (the mechanism landed in #166; the branch-protection click was deliberately left as the last step) | **2026-09-09** (Founder, in Settings → Branches) | The rule now lists two required checks. Nothing about the repository changed on the day it closed, which is the point: this was a condition no code change could have signalled, and no code change did. **It was raised in five consecutive session reports before the register existed and once after** — the sixth mention is this row, and it is the last, which is the whole argument for a list over a repeated paragraph. What it bought: ADR-073's reshaping — `browser-e2e` reports `skipping` rather than not reporting — is what made it requirable without permanently blocking documentation-only pull requests, and that reshaping was worth nothing until the click happened. |
| Stripe integration non-functional against `invalid_v2_key` | 2026-08-24 (written) | **2026-08-30** (key replaced in Railway) | A `STRIPE_SECRET_KEY` truncated by one character (ADR-038). **Nothing re-read the two documents asserting it**, so the claim stood in the present tense for fourteen days and was repeated as current in a pull-request report. Closed by execution on 2026-09-07: `POST /restaurants` returns 201 with a real connected account. This is the incident that produced ADR-078 and this file. |
