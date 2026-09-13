---
title: ADR-090 — The dispute handler converges
version: 1.1.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-090 — The dispute handler converges

**Status:** Accepted (Sprint 16), 2026-09-13. Closes the hole
[ADR-089](ADR-089-a-stripe-id-names-one-thing.md) opened deliberately: its index stopped a duplicate
dispute by making the second delivery **fail**, which is better than duplicating and is not an
answer.

---

## What happens to the claim when the handler fails — measured first, because it sets the severity

`claimEvent` writes its row and `dispatch` runs the handler: **two transactions, not one.** When
`dispatch` throws, `handleEvent` **deletes the claim** and rethrows.

Delivered against the real database — a `charge.dispute.created` for a dispute already recorded:

```
second delivery threw:                     PrismaClientKnownRequestError
key of the FIRST (successful) delivery:    COMPLETED
key of the SECOND (failed) delivery:       ABSENT
chargebacks: 1      CHARGEBACK entries: 1
```

**Ours is the loop, not the silent loss.** The two candidates were:

- *key survives* → the event counts as handled, no row exists, **the dispute is lost in silence**;
- *key is gone* → Stripe retries, fails again — **a loop**.

The claim is gone. So nothing is lost and no money is wrong: the row and the entry stay at one, and
the cost is an endpoint answering 5xx to the same event until Stripe stops trying. That is the
milder of the two, and saying so is what keeps this from being written up as a data-loss incident.

**The deletion is deliberate and correct** — its own comment explains it: `FAILED` is terminal for a
client-minted key, but Stripe resends the *same* event id, so deleting lets a transient failure be
retried cleanly. It is right for a transient failure and it is precisely what makes a *permanent*
one repeat.

---

## What Stripe does with an endpoint that returns 5xx

From Stripe's own documentation (`stripe docs /webhooks`), quoted rather than remembered:

> "Stripe attempts to deliver events to your destination for **up to three days** with an
> exponential back off in live mode." … "We retry event deliveries created in a sandbox **three
> times over the course of a few hours**."

> "If Stripe retries an event (for example, your endpoint previously replied with a non-2xx status
> code), then we generate a new signature and timestamp for the new delivery attempt."

**What that answers:** the schedule (exponential back-off) and the bound (three days live, three
attempts in a sandbox). So the loop is bounded: one dispute, erroring for up to three days.

**What it does not answer:** whether Stripe **disables** an endpoint by itself under sustained
failure. The only disabling the page describes is a destination *you* disabled or deleted, and its
effect on pending retries. **Not found in the documentation reachable from `stripe docs`** — which is
*not found*, not *does not happen*. A vendor requirement holds inside the bounds the vendor states,
and this one is unstated.

---

## How many event types reach this handler

Four dispute event types exist at Stripe; **two are routed and one creates a row.**

| event | routed to | creates a Chargeback? |
|---|---|---|
| `charge.dispute.created` | `handleDisputeCreated` | **yes — the only one** |
| `charge.dispute.closed` | `handleDisputeClosed` | no — `findFirst`, then `update`, and it returns early when the status is no longer `UNDER_REVIEW` |
| `charge.dispute.updated` | `default` | no — logged at debug, claim marked COMPLETED |
| `charge.dispute.funds_withdrawn` | `default` | no — same |

**So a second `created` is a retry, not several event types doing normal work.** By the Founder's own
criterion that would make convergence desirable rather than obligatory — and the measurement above
makes it obligatory for a different reason: the retry is what loops, for three days, on an endpoint
that answers with an error.

**Recorded without changing anything:** an unrouted dispute event is acknowledged as handled.
`funds_withdrawn` is the moment Stripe actually takes the money, and this system posts its
provisional loss on `created` instead — consistent as a design, and worth a deliberate look on its
own axis rather than a silent one here.

**That look happened the same day: [ADR-091](ADR-091-what-the-ledger-converges-by.md).** It measured
both outcomes of `closed` and found the Ledger converges on the disputed amount — by `REFUND_CONTRA`
— and that a second number Stripe moves, the **dispute fee**, is modelled nowhere (OC-14). It also
confirmed by delivery what this table asserts from routing: `funds_withdrawn` and
`funds_reinstated` reach the service, are logged at debug, have their claim marked `COMPLETED`, and
leave the Ledger unchanged.

---

## The fix: a conditional insert whose signal is the row count

```ts
const chargebackId = randomUUID();
const inserted = await tx.$executeRaw`
  INSERT INTO "chargeback" (...) VALUES (...)
  ON CONFLICT ("processor_dispute_id") DO NOTHING
`;
if (inserted !== 1) return;          // converged: acknowledged, nothing written
await tx.transaction.update(…);
await this.ledger.postJournalEntry({ …, chargebackId }, tx);
```

**The Ledger entry is written because one row was inserted, not because the method reached the
end.** That is the whole distinction, and it is why this is not an upsert: **a blind upsert returns a
row whether it inserted or updated**, so nothing downstream can tell the two apart and the entry
goes out twice. The count is the only fact that separates *this delivery created the dispute* from
*an earlier one did*.

The id is generated here rather than read back, because `DO NOTHING` returns no row. When
`inserted === 1` it is the row's id; when it is 0 nothing below runs and the id is discarded.

**Third use of one idiom, deliberately not a fourth variant** — `RestaurantService.createOnboardingLink`
guards a first-request stamp, [ADR-088](ADR-088-one-active-membership-per-scope.md) claims an
invitation, this claims a dispute. The refund handler, which already converges its own way, was not
touched: it works and it is outside this axis.

---

## Falsification, and the pair distinguishes the two mechanisms

The new contract: a second delivery answers **200**, leaves **one** Chargeback and **one** CHARGEBACK
entry, and its claim ends **COMPLETED** — the last being what actually stops the retry, since a
deleted claim is re-claimed on the next attempt.

The previous test asserted the opposite (`rejects.toThrow()`), and it failed the moment this landed —
which is the required proof that the old implementation answered with an error.

**Two neutralisations, two different failures:**

| removed | how it fails |
|---|---|
| the recognition, index kept | `promise rejected "PrismaClientKnownRequestError" instead of resolving` — the handler did not recognise a dispute it holds |
| the index, recognition kept | `Raw query failed. Code: 42P10 — there is no unique or exclusion constraint matching the ON CONFLICT specification` — there is nothing to recognise against, and the **first** delivery already fails |

Neither message could be mistaken for the other, which is what makes the test a check on **both**
mechanisms rather than on their combination.

---

## What this does not close

**No general webhook-deduplication mechanism was built.** ADR-089 measured six cases and they are
guarded by four different things — a primary key, a status check, a unique constraint, a cumulative
amount. Choosing one shape for all of them from inside a single handler would be adopting a form
without having looked at the other five. That table is its own decision.

**The read-modify-write class is still not closed**, and three ADRs of constraints do not close it.
What closes, each time, is the consequence in one place.
