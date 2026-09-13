---
title: ADR-085 — A queue with only one exit
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-085 — A queue with only one exit

**Status:** Accepted (Sprint 16), 2026-09-13. Decides [ADR-084](ADR-084-two-bounded-queues-that-never-drain.md)'s
**option A**, which is also [ADR-083](ADR-083-the-retry-has-a-backoff-and-finality-lives-elsewhere.md)'s
undecided **option D** reached from the other side. One change closes both.

---

## The mechanism, in one sentence

`OutboxPollerService` and `PaymentReconciliationService` each select a bounded, oldest-first batch
of rows — 50 and 100 — and each has **exactly one way for a row to leave the query: success**.
Everything else is retried forever. A row that can never succeed therefore holds a batch slot
permanently, and rows behind it wait behind something that will never move.

Both bounds are correct and neither is touched here. The defect is not the bound; it is that
**neither queue can tell a temporary failure from a permanent one**, because nothing in either
service has ever been able to say the second thing.

---

## Three things established as fact before anything was changed

### 1. The growth rate reported as ~70 stale rows a day is wrong, and the shape is not a rate

ADR-084 recorded 42 stale PENDING payments; a day later there were 112 against a bound of 100, and
the natural reading was about 70 a day of ordinary work — which would put the local gate red every
day and a half. **Measured directly, the rows do not arrive that way.** Every one of the 50 stale
PENDING payments in the dev database was created inside **two clock hours** on 2026-09-12:

```
 hour                | pending payments | unpublished outbox events
 2026-09-12 09:00    |        5         |          178
 2026-09-12 10:00    |       45         |          105
 (every other hour)  |        0         |            0
```

Those two hours are a sequence of gate runs. On 2026-09-13, with no suite run, **zero** of either
appeared. So the correct statement is per suite run, not per day: **roughly 50 stale payments and
280 unpublished events per heavy testing session, and none at all on a day without one.**

This matters in two directions and they point opposite ways. The urgency argument is weaker — the
gate goes red after a few heavy sessions, not on a calendar. The correctness argument is
**stronger**, because it means the dev database was never the thing being measured: what was being
measured was a queue that cannot finish, using test runs as its clock. Nothing about a production
queue is improved by the fact that developers happen to generate the rows here.

### 2. A money event without a `journalEntryId` is not the symptom it looked like

The Founder's instruction was to establish what such an event means before teaching a queue to skip
it — whether it is genuinely unresolvable or a defect upstream about to be swept under a rug. It is
neither, and the answer took one query and one reading of the writer:

- **Every** unpublished `journal_entry.*` event in the dev database whose payload the poller cannot
  use is a **test fixture**. 62 carry the literal string `"not-a-valid-uuid"`, written by five call
  sites in `outbox-poller.service.spec.ts`. 8 carry `{}`. 8 more carry a random UUID as their
  `event_type`, written by `ledger.service.spec.ts`'s atomicity test. Not one of them was produced
  by the product.
- **The product cannot produce one.** `LedgerService.postJournalEntry` is the only writer of
  `journal_entry.*` events, and it writes `payload: { journalEntryId: entry.id }` in the same
  transaction that creates `entry` — a row that exists by the time the payload naming it is
  written. There is no path by which the id is absent or malformed.
- **A well-formed id matching no JournalEntry is not a failure at all.**
  `WalletProjectionService.handleJournalEntryEvent` finds no membership-scoped lines and does
  nothing, which is a documented, successful outcome. So the only rejectable money payload is one
  that could never identify a row.

**So there is no upstream defect here, and this is stated plainly rather than assumed in either
direction.** What is real is that the product has no way to *say* a payload is unusable, and one
real permanent failure does exist and is deliberately **not** covered by this change — see *What
stays a failure* below.

### 3. The production analogue is not the outbox. It is the Payment.

`Payment.status` has had `CANCELED`, `FAILED` and `DECLINED` in its enum since the schema was
written (DATABASE.md's own Payment rules describe the transition). **Nothing in this codebase has
ever written any of them.** Two writers exist: `PaymentService.createPaymentIntent` writes
`PENDING`, and the `payment_intent.succeeded` webhook writes `SUCCEEDED`. That is the whole set.

Which means: in production, **a customer who abandons the payment sheet, or whose card is declined,
leaves a Payment row in PENDING forever.** Fifteen minutes later reconciliation picks it up, asks
Stripe, gets a non-succeeded status, alerts once, and leaves it exactly as it was — then does the
same every five minutes, from the head of the batch, for the life of the database. Abandonment and
decline are not edge cases in card payments; after success they are the most common outcomes there
are.

**This is the part that is a property of the product rather than of anyone's laptop**, and it would
have arrived as a production incident whose first symptom — a genuinely stuck payment not being
self-healed — points nowhere near its cause.

---

## Decision

**Option A of ADR-084: give the queue a second exit.** A handler may declare that a row can never
succeed, and the queue records that conclusion instead of scheduling another attempt.

The vocabulary is one shared error class, `common/errors/permanent-rejection.ts`, used by both
queues — which is what makes "one mechanism, two applications" a fact about the code rather than a
claim in a document.

### The test for what may be rejected

**Would concluding this row lose work that actually happened?** If yes, it is not a rejection,
however permanent it looks. Three cases, decided:

| case | permanent? | rejection? | why |
|---|---|---|---|
| payload with no valid `journalEntryId` | yes | **yes** | refers to no JournalEntry, so there is no Wallet behind it to leave wrong |
| Stripe PaymentIntent that does not exist (`resource_missing`) | yes | **yes** | an id Stripe never issued will not begin to exist |
| `recomputeBalance` throwing on a multi-currency Membership | yes | **no** | the money is real and the Wallet is wrong; dropping it makes the system quietly wrong instead of loudly stuck |

The third row is the reason this is a named error class thrown deliberately rather than a
generic "is this permanent?" predicate. **Permanent and safe-to-conclude are different properties**,
and ADR-075 has said since it was written that giving up on money has never been decided. It still
has not been.

### What each queue does now

**Outbox.** `abandoned_at` and `abandoned_reason` on `outbox_event`; the poller's query adds
`abandoned_at IS NULL`. A payload whose `journalEntryId` is missing **or not a well-formed UUID**
raises `PermanentRejection`, and the event is concluded with its reason recorded, one alert, and no
further attempts. The UUID *shape* check is a widening of an existing guard rather than a new one:
`"not-a-valid-uuid"` previously passed validation and failed one layer down as a cast error from
the driver — indistinguishable, at the catch site, from a connection problem. The original reason
for validating at all (Prisma reads `journalEntryId: undefined` as *omit this filter*, which would
recompute every Membership in the database) applies to a malformed id exactly as it applies to a
missing one.

**Reconciliation.** No new column and no change to the query, because the terminal states were
designed in from the start and simply never wired up. Stripe reporting `canceled` — one of exactly
two terminal PaymentIntent statuses — concludes the Payment as `CANCELED`. `StripeService` now
translates Stripe's `resource_missing` into `PermanentRejection`, and reconciliation concludes such
a Payment as `FAILED` with an alert that says Stripe does not have it, rather than the previous
message blaming a connection that was never the problem.

### Not a delete, in either queue

An abandoned row is the only surviving evidence that something produced work this system could not
use. Deleting it would destroy the record and leave `abandoned_reason` attached to nothing. The rows
stay, unpublished forever, queryable as *what has this system given up on, and why*.

---

## What stays a failure — the half that must not change

A transient failure keeps **exactly** today's behaviour: counted, backed off by ADR-083's doubling
schedule, alerted at five attempts on the same channel with the same wording, and retried forever.
Transient is the **default**: a network timeout, a database deadlock, a provider outage and a bug
in our own projection code all take the old path. Only an error a handler raised deliberately,
having seen that the input refers to no real work, takes the new one.

This asymmetry is load-bearing. Misreading a transient failure as permanent discards real work, and
on this system real work is money.

---

## What this does NOT reach, and it is the Founder's decision

**A PaymentIntent that sits at `requires_payment_method` is not concluded, and the head still fills
with those in production.** This is named rather than left to be discovered.

Of Stripe's seven PaymentIntent statuses only `succeeded` and `canceled` are terminal. An abandoned
checkout sits at `requires_payment_method`, which means it *could* still be paid. Concluding such a
Payment on our side alone is unsafe in a specific way: the intent stays live at Stripe, a later
success webhook would run the normal capture, and money would be captured against a Payment already
written off.

Doing it safely means **cancelling the intent at Stripe first** — an outward action against a
customer's live payment, after some window. That is ADR-075's own shape (a duration in the world,
not an attempt count) and it is a product decision, not an engineering one: it decides that after N
hours this company declares a customer's payment over. The window has no measured value either —
nobody has established how long after a restaurant payment begins it can still legitimately
complete.

**Recommendation, for when it is decided:** cancel at Stripe with `cancellation_reason: "abandoned"`
after a window measured against real payment latency, then conclude as `CANCELED` through the same
`conclude()` path this change introduces. The mechanism is already here; only the policy is missing.

---

## Alert semantics: what changed, and what did not

The instruction was not to decide alert semantics unless they are an unavoidable part of the chosen
option, and to say so if they are. **They are not, and the count is unchanged in every case:**

| case | before | after |
|---|---|---|
| unusable outbox payload | one alert, at attempt 5, ~10s after it was written | one alert, at attempt 1, saying it was abandoned |
| Stripe reports `canceled` | one alert (`reconciliationAlertSentAt` gates it) | one alert, same gate, saying it was concluded |
| PaymentIntent missing | one alert, saying Stripe could not be reached | one alert, saying Stripe does not have it |
| transient failure, either queue | unchanged | unchanged |

No alert was added, removed, or moved to a different channel. The threshold, the once-per-event
gate, and the wording of the repeated-failure alert are all untouched.

**One consequence of TODAY's behaviour is surfaced without being changed, because it becomes real
the moment payments flow:** every abandoned or declined checkout produces one operational alert.
That is true before this change and after it. At volume it is the rubber-stamp decay `CLAUDE.md`
describes — the channel someone is meant to wake up for, carrying the most ordinary event in
payments. It belongs with ADR-083's still-open defect three, and it is the Founder's to decide.

---

## Falsification

Each claim was checked by removing the implementation and confirming the right test fails — and, in
two places, by confirming a test that must **not** change stayed green.

**1. A head of unresolvable rows must not stop fresh work.**
Outbox: 60 unprocessable events dated ahead of everything else, plus one good event immediately
behind them. With the fix, all 60 are concluded and the good event publishes; then every ballast row
is made due again (the real steady state — the dev database was measured with every stuck row
eligible) and a further poll attempts **none** of them. With `abandoned_at IS NULL` removed, the
already-abandoned rows flood the head again and **six tests across the file fail**, including the
plain "poll() dispatches a real event" case — the defect demonstrating itself.
Reconciliation: 110 unresolvable stuck payments plus one behind them; with the terminal write
removed, *"a payment behind a head of unresolvable rows was never reached"*.

**2. A transient failure must keep backoff-and-retry, not be discarded.**
Outbox: a well-formed event whose handler throws is counted, scheduled, and `abandoned_at` stays
null. Reconciliation: a connection error leaves the Payment `PENDING`, alerted once, and still
checked on the next cycle. Both are the discriminating pair for (1) — same call, same throw site,
opposite answer — and both stayed green under the neutralised implementation, which is what makes
them a pair rather than a duplicate.

**3. What a money event without a `journalEntryId` means.** Established above, by query and by
reading the only writer, before any code was changed.

A side effect worth recording, because it is an argument for this option over ADR-084's option B:
**the dev database is cleaned as a consequence of the mechanism working**, not by a sweep. The first
suite run after this change concluded 139 rows that had been in the queue for two days. No matcher
to keep in step with the fixtures, and nothing that could silently under-delete.

Five spec fixtures had to change and the reason is itself a finding: tests that needed "an event
that fails every time" produced one with `"not-a-valid-uuid"`, which is now concluded on its first
attempt. Every assertion about backoff, attempt counts and the alert at five attempts would have
been asserting something that can no longer happen. They now fail **inside the handler**, on a
well-formed event — which is what those tests were always about.

---

## Why not the other four options

- **B, a dev-only sweep matched to fixture naming.** Treats the environment, not the product. Its
  failure mode is silent under-deletion, and it is an allow list by another name — a file someone
  edits to make the build green, which this repository has watched rot twice. It also cannot
  reach production, where the same head exists.
- **C, ordering by attempt count instead of age.** One line, no new state, and it makes starvation
  impossible without concluding anything. Refused because oldest-first is correct for money — a
  projection delayed longest should go first — and because it changes a production ordering to
  relieve a symptom rather than removing the cause. Worth revisiting only if a class of genuinely
  unresolvable-but-unsafe-to-conclude rows ever appears; the multi-currency Wallet throw is the one
  candidate, and it does not exist yet.
- **D, raising the bounds.** Moves the threshold without removing it.
- **E, nothing.** Three sessions have now been spent on this queue's head and none of them started
  out looking like a queue problem.

---

## Consequences

- One migration, two nullable columns and one index replacement on `outbox_event`. Existing rows
  backfill to NULL deliberately: nothing has been abandoned yet, and the rows that qualify are
  concluded on the first poll after deploy, each with its own reason attached.
- `PaymentReconciliationService` begins writing terminal `Payment` statuses for the first time.
  Screens and exports read `SUCCEEDED` rows, so nothing user-facing changes today — but a
  `CANCELED` or `FAILED` Payment is now a state the system can produce, and anything added later
  that assumes `PENDING` means *in flight* must say which of the two it means.
- `StripeService` now classifies one Stripe error code. Everything else it can raise is rethrown
  untouched.
- **Still open after this:** the abandonment window for non-terminal intents (above); ADR-083's
  defect three, alert semantics; and whether a multi-currency Wallet should ever be concluded,
  which stays undecided because nothing has made it real.
