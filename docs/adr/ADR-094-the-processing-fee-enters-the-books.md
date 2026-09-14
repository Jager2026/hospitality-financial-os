---
title: ADR-094 — The processing fee enters the books
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-094 — The processing fee enters the books

**Status:** Accepted (Sprint 16), 2026-09-14. Closes the half of **OC-15** that turned out to be
cheap: [ADR-093](ADR-093-where-stripes-fee-is.md) measured that Stripe's fee is **unfetched, not
unseeable** — one `expand`ed retrieve away — and this is the fetch, the entry and the screen.

**What it does not do is rename anything.** The chart-of-accounts classes ADR-093 found wrong under
direct charges stay exactly as they are; that is a separate pull request and OC-15 still holds it.

---

## 1 · What "the venue's revenue" should mean — the options, and this ADR does not pick one

Two fields exist today and both stop answering their own question the moment a third deduction is
real:

| field | asks | after this change |
|---|---|---|
| `grossAmount` / `shiftRevenue` | how much business did we do | unaffected — a sales figure, and correct as one |
| `netRestaurantRevenue` | the restaurant's share of the bill | still net of **our** fee only |
| `processingFee` | what Stripe took | a number instead of *"Not available"* |

**Option A — one field, "what actually remained", with the deductions listed under it.** The screen
gains a single number a venue can reconcile against its own bank, and every deduction becomes a
line beneath it rather than a separate top-level figure.

- *What it costs:* `netRestaurantRevenue` either changes meaning or disappears, and it is already in
  the API contract and the CSV export. A figure that changes meaning without changing name is the
  worst of the three outcomes.
- *At the fourth deduction* — currency conversion, or Instant Payouts under Model B — it holds. A
  new deduction is a new line in an existing list, and the headline number stays the answer to the
  same question.

**Option B — keep both fields and add the third.** What this pull request does, because point 4
required the existing `processingFee` line to carry a real number and that is compatible with both
options.

- *What it costs:* nothing today, and the cost is deferred rather than avoided. Each new deduction
  is a new top-level field, and no field anywhere answers *"what did I actually receive"* — the
  reader is left to subtract.
- *At the fourth deduction* it degrades: four sibling figures with no total, and the arithmetic
  moves into the reader's head, which is where errors go unnoticed.

**Not chosen here, deliberately.** The Founder asked for the options rather than a decision, and the
decision belongs with whoever decides what a venue's statement is for. **What this change does is
keep both doors open:** the Ledger now holds the fee as its own account, so Option A is a
presentation change later rather than a second measurement.

**The form of the API outlives the form of the table**, so the one thing settled here is that the
fee is a *field with a state* rather than a nullable number — see §4.

---

## 2 · The fetch runs on the Outbox's schedule, and "not yet" is a retry

**Measured, in ADR-093: `charge.balance_transaction` is `null` on a retrieve made immediately after
confirmation and populated seconds later.** A fetch inside the capture handler's transaction would
therefore be a network round trip inside a database transaction, *and* would frequently return
nothing — leaving the fee permanently missing with nobody told. That is the same defect this change
exists to remove, entered from the other side.

So capture writes a request — `processor_fee.fetch_requested`, payload `{ paymentId }` — in the
**same transaction** as the Transaction it belongs to (ADR-003). A capture that commits always has a
fee fetch behind it; one that does not commit leaves no orphan asking.

`ProcessorFeeService` is the poller's **third** consumer. A `null` from Stripe is a retry under
ADR-083's backoff, not a result.

### The limit, named — and what happens after it

`MAX_FEE_FETCH_ATTEMPTS = 4`, and the number is chosen against two others rather than picked:

- ADR-083's backoff is 2s, 4s, 8s — four attempts spend about fourteen seconds waiting for a value
  measured to appear within seconds;
- the poller's `MAX_ATTEMPTS_BEFORE_ALERT` is **five**, so stopping at four means the alert a
  permanently-missing fee raises is *this handler's own*, which says what happened, rather than the
  generic "OutboxEvent has failed repeatedly", which does not.

**After the limit the event is abandoned and the abandonment alerts** (ADR-085/ADR-087: a real
payment whose fee is never recorded is a permanent hole in the books, which is what an operational
alert is for). The Transaction keeps `processorFeeBalanceTxnId = null`, **and that is what the
screen reads to say _never_ rather than _not yet_.** A payment without a fee forever is a new silent
incompleteness, so it is deliberately not silent: an alert for the operator, a different sentence
for the venue.

---

## 3 · The entry: a second posting, idempotent by a claim

```
DEBIT  PROCESSOR_FEE        63
CREDIT PROCESSOR_CLEARING   63
```

**A second entry, never a correction of the capture** — the amount is not known when the payment is
captured, and ADR-002 forbids editing a posted entry. Same shape as ADR-090's dispute reversal.

**`PROCESSOR_FEE` is not named as the platform's expense**, because [ADR-092](ADR-092-the-platform-pays-stripe-nothing.md)
established it is not: with direct charges Stripe debits the **connected** account's balance. It is
the venue's cost passing through our books. Its *class* under the chart of accounts is part of the
rename OC-15 holds open and is not decided here.

**Idempotency is a claim, because nothing below it can catch a duplicate.** ADR-089 established that
the balance trigger sums an entry's own lines and has no opinion about whether another entry
describes the same thing. So:

```ts
const claimed = await tx.transaction.updateMany({
  where: { id: transaction.id, processorFeeBalanceTxnId: null },
  data:  { processorFeeBalanceTxnId: fee.balanceTransactionId },
});
if (claimed.count !== 1) return;   // converged: another delivery was first
```

**Fourth use of the project's named idiom** — *conditional write, row count as the signal* — and
deliberately not a fourth variant of it. The claim and the posting are **one transaction**: a claim
that committed without its entry would mark the fee handled with nothing behind it, permanently,
which is the silence this change exists to remove appearing inside its own remedy.

The column is `UNIQUE` because it is an identifier issued by Stripe naming exactly one object —
OC-13's rule — and NULL means *not posted yet*, which many rows are at once.

**Two refusals, both deliberate.** A settlement currency different from the Transaction's is a
`PermanentRejection`: conversion is not modelled, and the balance trigger sums *per currency*, so a
foreign-currency line would balance and still be wrong. A fee of zero sets the claim and posts no
entry — a zero-amount line is noise, the convention `PAYMENT_CAPTURED` already follows — which is
exactly why the screen reads the **claim** rather than the entry: *known and zero* must not collapse
into *not known*.

---

## 4 · Three states on screen, because two of them are not the same fact

| state | when | what the venue reads |
|---|---|---|
| `available` | the claim is set | the money |
| `pending` | no claim, the request is still queued | *"Not in yet — usually within a minute"* |
| `unavailable` | no claim, and the request was abandoned — or predates this mechanism | *"Never received from Stripe"* |

**The third must not look like the second**, which is why this is a state and not a nullable number:
a reader who cannot tell them apart keeps waiting for a figure that is not coming. ADR-025's rule
survives intact — a known fee of zero renders as zero, and only an unknown one renders as words.

The status is **derived, not stored**: the claim column answers *is it known*, the Outbox row
answers *is it still coming*, and a copy of the second on the Transaction would be a denormalisation
that drifts the first time the two are written apart. One extra query on a single-row detail
endpoint; the CSV export asks only for the account nets and never pays it.

---

## 5 · Falsification — measured by removing each mechanism, not predicted

| removed | how it fails |
|---|---|
| the fetch (capture stops writing the request) | `capture did not request this payment's processing fee: expected [] to have a length of 1`, and **five of five tests fail** — the other four with `Cannot read properties of undefined`, there being no event to hand the handler |
| the claim (the conditional update made unconditional) | `the same fee was debited twice: expected 126n to be 63n`, and **exactly one test fails** |

Neither message could be mistaken for the other, and the count of casualties differs too — the
second signal that the two mechanisms are checked separately rather than as a pair.

A third test holds the case the schedule exists for: with Stripe returning nothing, the handler
**throws a retry**, posts no entry, leaves the claim NULL, leaves the event queued, and the screen
reads `pending` with `processingFee: null` — *no zero is invented for an unknown amount*.

---

## What it cost, which was not in the plan and is the most useful part of this record

**One extra Outbox row per payment is not a free addition, and the gate said so five times.** The
work was designed, written and tested in about an hour; making the suite green took longer than
that, and every failure was real rather than flaky:

| what failed | why, diagnosed from the captured log |
|---|---|
| `this.logger.setContext is not a function`, seven tests | the new dependency was inserted **before** `logger` in the constructor, and eight positional `new OutboxPollerService(...)` call sites in one spec silently shifted |
| `repo-invariants: keeps seeded Role names out of hand-written permission fixtures` | the new spec's caller was a literal `"Owner"` with an invented permission list — the exact fixture class this project already refuses, refused on its first run |
| `this.stripe.retrieveProcessingFee is not a function` | **five** hand-written copies of `FakeStripeService`, each now missing a method the real service has. A double of an interface drifts the moment the interface moves, and five copies drift five times |
| an e2e assertion on *"Not available"* | the old wording was the old contract. Replaced with the new one, and with the assertion that a *never* is **not** worded as a *not yet* |
| `analytics.service.spec.ts` timing out at 5000ms | a real-database suite on the default budget, which had always been inside the noise — the shape `CLAUDE_RULES.md` names. Given a suite budget, and the budget verified by setting it to `1` and confirming every case times out |

**And two that were the same defect from two sides, both about the queue.** A fee request carries
`attempts: 0`, and the poller treats every `attempts: 0` row as due on every poll — so one per
payment, on a suite that captures many, filled the oldest-first batch of fifty and starved the
poller's own specs. Measured at the moment of failure: **341 queued fee requests against about 90
of everything else.** Three things followed, and only the third is a product change:

1. **The harness owns the rows it leaves** (ADR-086's rule): `concludeUnfetchableProcessorFees`
   concludes fee requests between runs, because every test Restaurant carries a synthetic Stripe
   account and the question can never be answered from there. Marked, never deleted.
2. **The poller spec's third-consumer double is the real service** with a Stripe that always answers
   *not yet*, so foreign fee requests back off and abandon exactly as they would in production,
   instead of a throwing stub leaving them due forever.
3. **`BATCH_SIZE` moved from 50 to 200**, and that is arithmetic rather than tuning: a captured
   payment now produces one more row than the batch was sized for, so a batch held at fifty covers
   proportionally fewer *payments* per tick. **It does not close OC-10** — an assertion about queue
   depth is still an assertion about queue depth — it stops this change from making it worse.

**One teardown mistake worth keeping**, because the rule broken was written by the same session:
this spec's first teardown **deleted** its Outbox rows, and a poller in another worker that had
already selected one failed with `Record to update not found`. Mark, never delete. The second
version abandons them, and a concurrent poller simply finds nothing to do.

---

## What this deliberately does not do

**The registry trigger has fired and is not taken.** `OutboxPollerService`'s own comment named the
third consumer as the moment a handler registry is earned — *"and by then the claim step should be
fixed too, because that is the same threshold"*. The claim step is the poller's behaviour when a
handler throws, which ADR-090 measured and left alone on purpose; changing dispatch and claim
semantics in one pull request would be exactly the attribution loss ADR-058 records. Recorded as
**OC-17**, with both halves together, because half of it is not the thing that was promised.

**No rename.** `PROCESSOR_CLEARING` is credited here under a name ADR-093 showed to be wrong for
direct charges. Using it is correct; fixing its name is OC-15's other half and its own change.

**The dispute fee (OC-14) is not closed, and is now cheaper.** It is the same money on the rare
path, and the mechanism it was waiting for — an account to put a processor deduction in, and a
scheduled fetch that reads a Stripe object the webhook does not carry — now exists.

**Five copies of `FakeStripeService` are still five copies.** Each gained the new method here;
none of them gained a shared definition, because collapsing five e2e doubles into one is its own
change with its own blast radius. It is named rather than fixed so the next interface change knows
what it will cost.

**Model B is not designed**, and `TIP_PAYABLE` is untouched: its name has to survive the move to
transfers, which is decided with Model B and not inside a change to Model A.
