---
title: ADR-089 — A Stripe id names one thing, and two of the three were fine
version: 1.1.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-089 — A Stripe id names one thing, and two of the three were fine

**Status:** Accepted (Sprint 16), 2026-09-13. Takes the gap
[ADR-088](ADR-088-one-active-membership-per-scope.md)'s measurement named — *wherever the natural key
is an identifier issued by Stripe, it is not constrained* — and closes it, after establishing by
execution what was actually at risk.

---

## What protects a redelivered webhook today, measured

Events were delivered against the real development database and rows counted. **Reading was wrong
twice, and each time execution caught it before it reached a document.**

| case | result | what stopped it |
|---|---|---|
| **A.** the same `event.id`, twice | 1 Transaction, 1 entry | `claimEvent` — `idempotency_keys.key` is the **primary key**, and the check-then-create is backed by it: the `create` that loses the race throws and the catch returns *already claimed* |
| **B.** a *different* `event.id`, same PaymentIntent | 1, **no error** | the `payment.status === "SUCCEEDED"` early return in `captureFromPaymentIntentId` |
| **C.** `captureFromPaymentIntentId` called directly — reconciliation's self-heal, which never sees an event id | 1, **no error** | the same early return |
| **D.** two **concurrent** captures of a fresh payment | 1, **one rejected** | `transaction.payment_id` is unique — the constraint, not the check |
| **E.** `charge.refunded` twice under different event ids | 1 Refund, 1 entry, no error | the handler's own `return; // nothing new — a duplicate or out-of-order delivery`, comparing the cumulative refunded amount against what the Ledger already reversed |
| **F.** `charge.dispute.created` twice under different event ids | **2 Chargebacks, 2 CHARGEBACK entries** | **nothing** |

**B, C and D are three different guards for three different orderings**, and an earlier reading of
this code claimed the unique constraint did the work in all of them. It does not: sequential
redelivery is stopped by a status check, and only the concurrent case reaches the constraint.

**E was expected to duplicate and does not.** The guard is deliberate and documented in the handler.

**F duplicates.** One dispute, debited from the Ledger twice.

### Payment creation is not the exposure

`POST /payments` carries `@UseInterceptors(IdempotencyInterceptor)` and `payment.idempotency_key` is
unique, so the request boundary is covered. And `StripeService.createPaymentIntent` passes **no
idempotency key to Stripe** — request options carry only `{ stripeAccount }` — so every call yields
a fresh intent id and a retried creation cannot return the same one. **No path was found that
produces two Payment rows for one intent.** That is *not found*, not *impossible*, and it is written
as the weaker of the two.

---

## What the Ledger does about a duplicate: nothing, and the Founder's reasoning was right

`check_journal_entry_balanced` sums debits and credits **for the affected `journal_entry_id`** and
compares them. Two duplicate captures produce two internally balanced entries, and the trigger has
no opinion about whether another entry describes the same source. There is nothing to object to in
that reasoning; it is confirmed rather than corrected.

**Reconciliation does not catch it either, and the reason is sharper than "late".** It selects
`status = 'PENDING'`. A payment that has been captured — twice or once — is `SUCCEEDED`. **It never
looks at the row at all.** So it is neither a detector after the fact nor a prevention: for this
class it is not a mechanism.

---

## Decision: three unique indexes, and they are not the same kind of thing

| column | kind | why |
|---|---|---|
| `chargeback.processor_dispute_id` | **a FIX** | closes case **F**, reproduced |
| `payment.processor_payment_id` | an **assertion** | `findFirst({ where: { processorPaymentId } })` appears in the capture path and in reconciliation and silently picks one row of N; the index makes that assumption checkable |
| `refund.processor_refund_id` | an **assertion** | the cumulative-amount guard is correct and is a rule in one code path |

Labelling them differently in the migration matters: the next reader should not be told that three
defects were fixed when one was.

### NULL semantics, decided per column and not inherited

ADR-088's index needed `NULLS NOT DISTINCT` because `restaurant_id` is nullable. **All three columns
here are `NOT NULL`** — confirmed against `information_schema`, not read off the model. So the clause
is **inapplicable**, which is a different statement from *declined*, and the reason it is recorded.

### Not partial, also per column

ADR-088's index is partial because a membership is deactivated and the row stays, so the same person
may hold the scope again. Nothing of that shape applies here: a Stripe PaymentIntent, refund or
dispute identifier names exactly one object in any status, and there is no second legitimate row to
make room for.

### Safe to apply

Zero duplicate groups in all three columns, measured immediately before writing the migration —
payment 3,112 rows, refund 270, chargeback 150. CI creates its Postgres container per run and starts
empty by construction.

---

## Falsification

Three tests in `processor-ids-unique.integration.spec.ts`, and the file says which is a regression
and which are assertions.

Dropping `chargeback_processor_dispute_id_key` and re-running the first test fails it with
*"promise resolved `{ received: true }` instead of rejecting"* — the second delivery succeeding is
precisely the duplicate.

---

## What this does NOT close, and one of them is now known rather than suspected

**Webhook deduplication semantics.** After this index the second delivery of a dispute **fails**
instead of duplicating. That is better — loud beats silent — and it is not the whole answer:
`handleEvent` rethrows, Stripe sees an error, and Stripe retries. The handler does not recognise a
dispute it already holds, the way the refund handler recognises a refund it has already reversed.
**That is a hole in dedup semantics, found by this measurement, and it has its own change** — one
risk per pull request.

**Closed the same day by [ADR-090](ADR-090-the-dispute-handler-converges.md)**, and its first
measurement settled the severity this one could only bound: `claimEvent` and the handler are **two
transactions**, and `handleEvent` **deletes the claim** when dispatch throws. So the defect was the
loop rather than a silent loss — nothing was lost and no money was wrong, and the cost was an
endpoint answering 5xx to one event for up to three days, which is Stripe’s documented retry
window.

**The read-modify-write class**, still. ADR-088 said two fixes and a constraint are not a mechanism;
three more constraints do not make one either. What closes, table by table, is the consequence.

**`restaurant.company_number` and `restaurant.vat_number` stay unconstrained, deliberately.** One UAB
owns several venues: a restaurant group registers once and opens five addresses, and every one of
those Restaurants carries the same company number and the same VAT number. Uniqueness there would
answer *"this company is already registered"* to a group opening its second venue — **the best
customer this product can acquire, at the exact moment they are expanding.** The reason is written
next to the fields in `schema.prisma`, not only here, because the next audit will propose the
opposite and will look right doing it. The identifier that genuinely is one-per-venue is
`stripe_account_id`, and it is unique.
