---
title: ADR-092 — The platform pays Stripe nothing, and the chart of accounts assumes otherwise
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-092 — The platform pays Stripe nothing, and the chart of accounts assumes otherwise

**Status:** Accepted (Sprint 16), 2026-09-14. Establishes who bears Stripe's costs in this
integration, which decides whether [ADR-091](ADR-091-what-the-ledger-converges-by.md)'s dispute-fee
gap is a **missing account** or a **missing entry**. It is the second.

**The answer, in one line: in this configuration Stripe bills the platform for nothing at all.**
Every fee — processing, dispute, Instant Payouts, Radar, Connect itself — is collected from the
connected account. So there is no processor-cost class to open, and **ADR-091's characterisation of
the dispute fee as "the platform's own cost, borne off-book" was wrong.** It is the restaurant's
money leaving, and the gap is that we do not record it.

**And a second finding, larger than the first and not the one that was being looked for:** the chart
of accounts in ADR-002 describes a platform that *holds* the customer's money and *owes* the
restaurant. Direct charges never put that money on the platform. See the last section — it is not
decided here.

---

## 1 · Which charge type, established from the code before reading any documentation

The documentation's answer depends entirely on the charge type, so the charge type was settled
first, in `StripeService.createPaymentIntent`:

```ts
await this.stripe.paymentIntents.create(
  { amount, currency, ...(applicationFeeAmount !== undefined ? { application_fee_amount } : {}) },
  { stripeAccount: params.stripeAccountId },   // ← the account the charge is created ON
);
```

**Direct charges**, and the account is `restaurant.stripeAccountId` — read at the call site in
`PaymentService.createPaymentIntent`, which passes the restaurant's account and the platform fee
computed from `billAmount`.

**Not the waiter's account.** A Membership's `stripeAccountId` is a *recipient* account
(`configuration.recipient`, `dashboard: "none"`), and `schema.prisma` already says what it is for:
*"it receives transfers, it never takes card payments"* (ADR-061, Model B). `createConnectAccount`
has exactly one caller — `RestaurantService` — so there is one configuration to check, not two.

---

## 2 · Who pays, quoted rather than reasoned

**The disputed amount:**

> "For disputes on payments created using direct charges, Stripe debits the disputed amount from
> **the connected account's balance, not your platform's balance**. Stripe can bill the dispute fee
> to either the platform or the connected account, **depending on the connected account's
> configuration**." — `stripe docs /connect/charges`

That answers the amount and explicitly refuses to answer the fee. The fee has its own page, and its
own property:

> "For dispute-related fees, responsibility depends on your connected account options. […]
> v2 Account with `defaults.responsibilities.fees_collector` = `application` → **Platform**;
> = `stripe` […] → **Connected account**." — `stripe docs /connect/direct-charges-fee-payer-behavior`

**Our value is `stripe`,** set explicitly at account creation and not inherited from a default:

```ts
defaults: { responsibilities: { losses_collector: "stripe", fees_collector: "stripe" } }
```

**So the connected account pays the dispute fee.** And the fallback does not reach us either: *"if
Stripe can't debit the amount, ultimate responsibility depends on whether Stripe or the platform is
responsible for negative balances"* — which is `losses_collector`, and *"if Stripe is responsible,
the value is `stripe`, and if your platform is responsible, the value is `application`"*
(`stripe docs /connect/risk-management`). Ours is `stripe`.

**Both branches of the Founder's fork were live until this was read, and the second one won.** The
dispute fee is not our expense. What is missing is not an account for it but an **entry** recording
that the restaurant's money left.

---

## 3 · The whole class, because the question is wider than the dispute fee

The same page carries the table for every product category. **"For Accounts v2, the ACCOUNT column
applies when `defaults.responsibilities.fees_collector` is `stripe`"** — which is our column:

| Stripe charges for | who is billed, at `fees_collector: stripe` |
|---|---|
| Stripe payment processing fees | **Connected account** |
| Dispute fees | **Connected account** |
| Instant Payouts | **Connected account** |
| Faster Payouts / Premium Payouts | **Connected account** |
| Radar | **Connected account** |
| 3D Secure | **Connected account** |
| Stripe Tax, Invoicing, Card Account Updater, Terminal add-ons | **Connected account** |

And Connect's own fee, from the same page's description of this setting:

> "Stripe collects fees directly from your connected account. **We don't charge any Connect fees to
> it or to your platform.** Any application fees that your platform bills to the connected account
> are in addition to Stripe fees."

**So the platform's cash flow with Stripe is one-directional: `application_fee_amount` in, nothing
out.** There is no processor-cost class to design, and a `PROCESSOR_COST` account added today would
have no row to hold.

**Three items from the Founder's list are not answered by that table, and are recorded as not
answered:**

- **Refund fees.** Not a row in the fee-payer table under that name. The field
  `stripe_refund_fees_subtotal_amount` exists in Connect margin reports, so the concept exists;
  which side is billed is **not found** on the page that decides the others.
- **Currency conversion.** Not a row either. Every Restaurant today is `country: "LT"`,
  `currency: "EUR"`, and the charge is created in the restaurant's own currency, so there is no
  conversion to attribute yet. It becomes a real question with the first non-EUR venue.
- **Instant Payouts in Model B.** The table's answer above is about the *restaurant's* account. In
  Model B the payout goes to a **waiter's** recipient account, which is a different account with its
  own configuration, created by code that does not exist yet. The answer for it will be whatever
  that code sets, and this ADR is the place to look before it is written.

---

## 4 · What this does NOT decide, and it is the bigger half

**ADR-002's chart of accounts describes a different Connect topology than the one the code uses.**
It names *"Processor Clearing (asset)"* and *"Restaurant Revenue Payable (liability)"* — a platform
that holds the customer's money and owes the restaurant its share. That is exactly right for
destination charges or separate charges and transfers. **With direct charges the money never enters
the platform's balance at all:** it lands on the restaurant's Stripe balance, the platform's
`application_fee_amount` is pulled out of it, and Stripe's own fees are deducted from the same
balance. The platform holds no asset and owes no liability.

**This is not a claim that the Ledger's numbers are wrong.** A ledger of *transaction economics* —
who earned what from this payment — is a defensible thing to keep, and every entry in it balances.
The claim is narrower and is about the labels: **two accounts are documented as the platform's asset
and the platform's liability, and under direct charges they are neither.** One of the two documents
is describing something that is not happening, and which one should change is a decision, not a
repair.

**It is left open deliberately** — recorded as **OC-15**, because:

- the Founder's boundary for this task was explicit: if the connected account pays, the decision
  does not enter this pull request;
- it is wider than a chart of accounts. It reaches what `RESTAURANT_REVENUE_PAYABLE` means for
  reporting, what a payout to a restaurant would be for (there is nothing to pay out — they already
  hold it), and whether Stripe's per-payment processing fee, which reduces what the restaurant
  actually receives on every single payment, belongs in our books at all. That last one is the same
  gap as the dispute fee and is **not rare**: it happens on every payment, not on the ones that go
  wrong.

**And one thing found while reading, unrelated to cost and recorded so it is not lost:** Stripe
documents a *late win* — *"in rare cases the status can change from lost to won […] Stripe labels
the dispute as a late win and returns the funds to your balance."* `handleDisputeClosed` returns
early when the Chargeback is no longer `UNDER_REVIEW`, so a late win arriving after a loss would be
acknowledged and ignored, leaving the provisional loss standing against money that came back.
Recorded as **OC-16**; the handler is not touched here.
