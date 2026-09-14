---
title: ADR-093 — Where Stripe's fee is, and what the chart of accounts asserts about us
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-093 — Where Stripe's fee is, and what the chart of accounts asserts about us

**Status:** Accepted (Sprint 16), 2026-09-14. Measures **OC-15** rather than arguing it, and the
measurement decides the size of the work: numbers wrong would be a defect to fix; labels wrong is a
record and a rename.

**It is labels.** Every figure a venue sees is arithmetically correct and every on-screen label is
honest, including the one that says the card processing fee is **"Not available"**. What is wrong is
three account *classes* in ADR-002 and one sentence of ADR-025's prose about what a venue-facing
number means.

**And one claim this project has stated twice is now falsified by execution:** the processing fee is
not a figure "this system cannot see". It is a figure this system **does not fetch** — one API call
away, with an `expand`.

---

## а) What the venue sees — gross, measured through the same code the screens call

One payment of **1200** (a 1000 bill plus a 200 tip) put through the real `payment_intent.succeeded`
path against the development database, then read back through `TransactionService.findOne` and
`DashboardService.getSummary` with an Owner built from the seed's own Role and Permissions:

```
GET /transactions/{id}          GET /dashboard
  grossAmount          1200       shiftRevenue           1000
  netRestaurantRevenue  990       shiftRevenueNote       "Before platform fee deduction"
  netTip                200       shiftTips               200
  netPlatformFee         10       averageBill            1000
  tax                     0
  processingFee        null
  refundedAmount          0
```

**Gross, in both places, and neither is net of Stripe.** `shiftRevenue` is the bill before *our*
fee, and says so. `netRestaurantRevenue` is net of *our* fee only. The UI label on that line is
**"The restaurant's share"** — which is what it is — and `processingFee` renders as **"Not
available"**, deliberately never `0` (ADR-025's own rule against a false zero in a financial
breakdown).

**So no screen shows what the venue actually receives, and no screen claims to.**

---

## б) Is there a Ledger line for Stripe's fee? **No** — and this is "no", not "not found"

Enumerated, not searched. Every `LedgerLine` the payment produced:

```
PAYMENT_CAPTURED DEBIT  PROCESSOR_CLEARING         1200
PAYMENT_CAPTURED CREDIT RESTAURANT_REVENUE_PAYABLE  990
PAYMENT_CAPTURED CREDIT PLATFORM_FEE_REVENUE         10
PAYMENT_CAPTURED CREDIT TIP_PAYABLE                 200
TIP_ALLOCATED    DEBIT  TIP_PAYABLE                 200
TIP_ALLOCATED    CREDIT TIP_PAYABLE                 200
total debits 1400   total credits 1400   gross 1200
ledger_account: processor_clearing, restaurant_revenue_payable, tip_payable,
                platform_fee_revenue, tax_payable, refund_contra
```

**Two independent reasons it is a categorical "no", not an empty search.** The gross enters whole
and leaves split three ways — 990 + 10 + 200 = 1200 — so there is no remainder a fee could occupy
without unbalancing the entry the database trigger checks. And the account it would need does not
exist in the enum, so no code path could write one without a migration.

---

## в) Does the amount reach us? **No.** One call fetches it.

Executed in **test mode** against Stripe (key verified `sk_test` before the script would run; the
platform account, since every connected account in the development database is synthetic). A real
€12.00 charge, confirmed with `pm_card_visa`:

| where we looked | what was there |
|---|---|
| the **event payload** — `data.object` of the real `payment_intent.succeeded` Stripe generated | `latest_charge` as a **string id**; the only fee-shaped field is `application_fee_amount`, which is **our** fee and not Stripe's |
| `Charge.application_fee` / `application_fee_amount` | null here; on a direct charge these carry **our** application fee, still never Stripe's |
| `BalanceTransaction` | `amount 1200, fee 63, net 1137`, `fee_details: type=stripe_fee, "Stripe processing fees"` |

**The fee exists, is material, and is nowhere in what we receive.** On this charge it was **63**
against our own platform fee of 10 — **six times larger than the deduction the Dashboard bothers to
mention.** That figure is this platform account's test-mode pricing, *not* the rate a Lithuanian
venue would pay; the ratio is the point, not the number.

**The cost of having it: one API call.**

```ts
stripe.paymentIntents.retrieve(id, { expand: ["latest_charge.balance_transaction"] })
// measured: fee=63 net=1137 in a single round trip
```

For a direct charge it needs the `{ stripeAccount }` request option as well, since the balance
transaction belongs to the connected account — the same option `retrievePaymentIntent` already
passes.

**One constraint found by executing rather than reading, and whoever implements this will hit it:**
`charge.balance_transaction` was **null** on a retrieve made immediately after confirmation, and
populated on a retrieve seconds later. A synchronous fetch inside the webhook handler can therefore
come back empty. That is an argument for fetching it on the Outbox's schedule rather than in the
handler's own transaction — not a blocker, but not something to discover in production.

**So the answer to "defect of display or of missing data" is: neither.** The data is available and
unfetched, which is a third thing, and a cheaper one than either.

---

## 2 · Which labels are wrong, account by account

| account | ADR-002 calls it | what it asserts today | what is true under direct charges |
|---|---|---|---|
| `PROCESSOR_CLEARING` | **asset** | the platform holds 1200 at the processor | the platform holds nothing; the money is on the venue's own Stripe balance. It is a **clearing contra** — the balancing side of an event, not a claim on funds |
| `RESTAURANT_REVENUE_PAYABLE` | **liability** | the platform owes the venue 990 | the platform owes nothing; the venue already holds it. The figure is the venue's **share of the bill**, an attribution |
| `TIP_PAYABLE` | **liability** | the platform owes the waiter 200 | under Model A the **employer** distributes tips (ADR-053). The figure is the waiter's **entitlement against the venue**, which the venue's own money already covers |
| `PLATFORM_FEE_REVENUE` | **income** | the platform earned 10 | **correct.** `application_fee_amount` really does land on the platform's balance — the only account of the six whose class survives direct charges |
| `REFUND_CONTRA` | contra-revenue | offsets a reversal | correct in use; it offsets the clearing side, which is what a contra account is for |
| `TAX_PAYABLE` | liability | — | no writer yet (ADR-007's "schema ready, not yet used") |

**Three of six carry a class that is wrong, one is right, one is unused, one is fine.**

### Do the numbers the venue sees change? **No. Directly: only the labels.**

- Nothing venue-facing reads `PROCESSOR_CLEARING` at all — it appears in exactly two places in the
  source, the capture handler that writes it and a docstring, so renaming it moves no figure.
- `netRestaurantRevenue` stays 990 under any renaming: it is `credits − debits` of one account, and
  the account's *name* is not an input to the arithmetic.
- The Dashboard's two accounts and their note are unchanged.

**The one thing that is not a label, and it is a sentence rather than a number.** ADR-025 says
`netRestaurantRevenue` *"answers 'what does the restaurant actually keep'"*. Measured, the venue
keeps 990 **minus its share of Stripe's fee** — 927 on this payment at test-mode pricing. The
arithmetic is right, the field name is right, the UI label *"The restaurant's share"* is right, and
**that one sentence of prose is wrong.** It is corrected in ADR-025 itself rather than here, because
a claim is corrected where it lives.

---

## Decision: no fix in this pull request, and the reason is the measurement

The Founder's rule was explicit — wrong numbers are a defect to fix; wrong labels are a record and a
rename without hurry. **The numbers are right.** So this ADR is the record, **OC-15** carries what
closes it, and the rename is its own pull request with its own list:

1. `ADR-002`'s chart of accounts — the three classes above.
2. The two places still asserting the fee is unobservable: `TransactionService`'s
   `processingFee: null // …a real, Stripe-held figure this system cannot see` and the same claim in
   `transaction-detail.tsx`'s docstring. **Not edited here** — a documentation pull request that
   quietly changes source comments is a documentation pull request nobody reviews as code.

**Model B is not designed here and is not a consideration in that rename.** It replaces the
topology, not the wording: tips would move by transfer to a recipient account, which makes
`TIP_PAYABLE` a liability again. Choosing names now that suit Model B would be adopting a shape
before looking at it.
