---
title: ADR-091 — What the Ledger converges by when a dispute closes
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-091 — What the Ledger converges by when a dispute closes

**Status:** Accepted (Sprint 16), 2026-09-13. Measured before it was written, because the answer
decided what the record had to say: a Ledger that converges is an ADR naming *what it converges by*;
a Ledger that does not is a **defect**, and would have been called one here.

**It converges.** On the disputed amount, in both outcomes, and by one account — `REFUND_CONTRA`.
What does not converge is a second number Stripe moves and this system does not model: **the dispute
fee**. That is the one thing left open, and it is open as a condition rather than a defect because
nothing recorded is wrong — something real is simply not recorded at all.

Delivered against the real development database on 2026-09-13, with a throwaway script deleted
afterwards. Amounts in minor units: a €10.00 payment carrying a €2.00 tip, platform fee 100 basis
points of the €8.00 bill.

---

## а) `charge.dispute.funds_reinstated` — two questions, and only one of them is answerable from here

The Founder's distinction is the right one and it splits in two:

**Does the handler ignore it? Yes — established by execution.** Delivered as a signed event to
`WebhooksService.handleEvent`, `charge.dispute.funds_reinstated` falls to the `default` branch. The
log line is `Unhandled Stripe event type: charge.dispute.funds_reinstated`, at **debug**; the
event's claim is marked `COMPLETED`; and the Ledger is untouched — journal entries for the
transaction stayed at 4 across the delivery. `charge.dispute.funds_withdrawn` behaves identically
(3 entries before, 3 after). So an arriving event is **acknowledged and discarded**, which is the
milder of the two answers.

**Is the endpoint subscribed to it? NOT ESTABLISHED — and that is "not found", not "no".** The
subscription list is not in this repository. `enabled_events` appears nowhere in the source, the
workflows or the infrastructure; the only record is prose in `ARCHITECTURE_DECISIONS.md` (ADR
Sprint 13, Decision 3) saying the production endpoint `we_1U6FfsB7fPzlR8NzThM2Ifhw` carries
`payment_intent.succeeded` / `charge.refunded` / `charge.dispute.*` / `account.updated` on the
Connected-accounts scope. **`charge.dispute.*` there is this project's own shorthand, not a copy of
what the Dashboard holds**, and it does not distinguish *all four dispute types* from *the two we
route*. The local `stripe` CLI has no API key configured (`stripe config --list` returns
`color`, `machine_uuid`, `project-name` and nothing else), so it cannot answer either.

**What would establish it:** `stripe webhook_endpoints list` with a live key, or reading the
endpoint in the Dashboard. One command, once. It is worth doing precisely because the two answers
differ in severity — *arrives and is ignored* is a decision we can revisit; *never arrives* means a
future handler for it would be written and would never run.

---

## б) What `closed` writes to the Ledger, both outcomes, measured

**WON — a second entry that reverses the first, line for line:**

| entry | line | measured |
|---|---|---|
| `PAYMENT_CAPTURED` | DEBIT `PROCESSOR_CLEARING` | 1000 |
| | CREDIT `RESTAURANT_REVENUE_PAYABLE` | 792 |
| | CREDIT `PLATFORM_FEE_REVENUE` | 8 |
| | CREDIT `TIP_PAYABLE` | 200 |
| `TIP_ALLOCATED` | DEBIT / CREDIT `TIP_PAYABLE` | 200 / 200 (the second carries the membership) |
| `CHARGEBACK` *"Provisional loss — dispute opened"* | DEBIT `RESTAURANT_REVENUE_PAYABLE` | 792 |
| | DEBIT `PLATFORM_FEE_REVENUE` | 8 |
| | DEBIT `TIP_PAYABLE` (membership) | 200 |
| | CREDIT `REFUND_CONTRA` | 1000 |
| `CHARGEBACK` *"Dispute won — reversing provisional loss"* | DEBIT `REFUND_CONTRA` | 1000 |
| | CREDIT `RESTAURANT_REVENUE_PAYABLE` | 792 |
| | CREDIT `PLATFORM_FEE_REVENUE` | 8 |
| | CREDIT `TIP_PAYABLE` (membership) | 200 |

`chargeback.status = WON`, `resolvedAt` set, `transaction.status = COMPLETED`.

**There is a reversing entry, and it is a second entry rather than an edit** — ADR-016's
one-`Chargeback`-to-many-`JournalEntry` shape, honoured. Its amounts are **read back from the
provisional entry's own `LedgerLine` rows**, not recomputed from the payment, so a won reversal
cannot disagree with what `created` actually posted even if the fee policy or the tip changed in
between. That is the same reasoning as reading `originalFeeAmount` out of the Ledger in the refund
path, and it is worth naming because the tempting version — recompute the split — is the one that
drifts.

**LOST — nothing further is posted, deliberately.** The provisional loss already describes the final
state; `chargeback.status = LOST`, `resolvedAt` set, `transaction.status` stays `DISPUTED`. Measured:
three entries before `closed`, three after.

---

## What it converges BY: `REFUND_CONTRA`, and the two net positions

Net per account after each outcome (debit positive), measured, not derived:

| account | WON | LOST |
|---|---|---|
| `PROCESSOR_CLEARING` | +1000 | +1000 |
| `RESTAURANT_REVENUE_PAYABLE` | −792 | 0 |
| `PLATFORM_FEE_REVENUE` | −8 | 0 |
| `TIP_PAYABLE` | −200 | 0 |
| `REFUND_CONTRA` | 0 | −1000 |

**WON returns the books to exactly the state of an undisputed capture** — the same five numbers a
payment that was never disputed would show, with `REFUND_CONTRA` back at zero.

**LOST converges through the contra account.** `PROCESSOR_CLEARING` keeps its original debit and is
never credited back; the withdrawal is expressed as a `REFUND_CONTRA` credit of the same size
standing beside it, so the clearing position nets to zero while the original capture stays visible
and immutable. Every payable returns to zero: the restaurant's revenue, the platform's fee and the
waiter's tip are each taken back in their own proportion, the tip line carrying the membership id so
the reversal reaches the same wallet the allocation credited.

**That is the answer to "what does it converge by": a contra account, not a reversal of the original
debit.** Nothing is edited, nothing is deleted, and the history of a disputed payment reads as two
facts rather than one corrected fact — which is what `CLAUDE.md`'s *financial history is immutable*
requires.

---

## в) The amount matches. The fee does not exist.

**The amount transcribes exactly.** `chargeback.amount` is `BigInt(dispute.amount)` and the
measurement confirms the transcription: 1000 in, 1000 stored. **That is a check on our copying, not
on Stripe's arithmetic** — the claim that `dispute.amount` is what Stripe withdraws is Stripe's, and
it is quoted rather than remembered:

> "To process a chargeback, the issuer creates a formal dispute on the card network, which
> immediately reverses the payment. This pulls the money for the payment—as well as one or more
> network dispute fees—from Stripe. After that, **Stripe debits your balance for the payment amount
> and dispute fee**." — `stripe docs /disputes`

**So the withdrawal is two numbers and we record one.** The fee is separate, not included.

And it is not recovered by winning:

> "**won:** Indicates that the bank decided in your favor and overturned the dispute. In this case,
> the issuing bank returns the debited chargeback amount to Stripe, and Stripe passes this amount
> back to you. For businesses in Mexico, the dispute fee might also be returned. **Otherwise, the
> dispute fee isn't returned.**"
> "**lost:** Indicates that the bank decided in the account owner's favor and upheld the dispute. In
> this case, the refund is permanent and **the dispute fee isn't returned**." —
> `stripe docs /disputes/responding`

**Which makes the WON reversal exactly, and wrongly, free.** Our books return to the undisputed
state; Stripe's do not, because the fee stayed taken. A won dispute costs money in reality and costs
nothing in this Ledger.

**Nothing models it anywhere.** Checked against the database's own enums rather than the code:

- `ledger_account`: `processor_clearing`, `restaurant_revenue_payable`, `tip_payable`,
  `platform_fee_revenue`, `tax_payable`, `refund_contra` — no processor-cost account of any kind;
- `journal_entry_type`: `payment_captured`, `tip_allocated`, `refund_issued`, `chargeback`,
  `adjustment`, `payout` — nothing a fee could be.

**This is an open condition, not a defect, and the distinction is exact:** every number the Ledger
holds is right, and the Ledger's own invariant (each entry balances per currency) is untouched.
What is missing is an entry for an event we do not process — the platform's own cost, borne
somewhere off-book. Recorded as **OC-14**, with the trigger on the precondition rather than on the
occurrence: a dispute is itself the thing that makes the gap real, so waiting for one is waiting too
long.

---

## What this does not close

**The provisional loss is posted at `created`, and the money moves at `funds_withdrawn`.** ADR-090
recorded this and it stays true: the two moments can be days apart, and this system commits at the
earlier one. That is defensible — it is the conservative direction, and it is what makes the WON
reversal meaningful — but it is a modelling choice that nothing in the code says out loud, and the
event that would let it be exact is the one falling to `default` (**OC-7**).

**A partial dispute was not measured.** `splitProportionally` handles `dispute.amount` smaller than
the payment, and the same reversal path reads the provisional lines back, so the shape should hold —
*should*, from reading. The measurement covered a full-amount dispute in both outcomes and nothing
else, and this paragraph exists so that nobody later reads the tables above as covering more than
they do.

**Whether the endpoint receives the two ignored event types at all** — а), above. One command
answers it and that command needs a key this machine does not have.
