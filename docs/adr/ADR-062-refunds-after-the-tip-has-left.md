---
title: ADR-062 — Refunds after the tip has left: what a reversal does when the waiter has already been paid
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-062 — Refunds after the tip has left: what a reversal does when the waiter has already been paid

**Status: Proposed.** Options are shown, none is chosen. The decision is the Founder's, after this report. No code.

---

## Context

**This is the most expensive place in Model B, and it is designed before the regulator answers** because the question it raises is Stripe's and the Ledger's, not the tax authority's.

ADR-023 reverses three accounts proportionally inside one sum — `RESTAURANT_REVENUE_PAYABLE`, `PLATFORM_FEE_REVENUE`, `TIP_PAYABLE` — and it works because in Model A the money is in one place: the restaurant's connected account, which the platform charges, and a Ledger that the restaurant settles against. **In Model B the tip is on the waiter's own account, and the waiter may have withdrawn it and spent it.**

**The question:** a guest demands a refund of a bill with a tip, two weeks later. The tip is with the waiter. What happens?

### What Stripe does — established against the live API on 2026-09-02, then the probe closed

A test-mode v2 recipient account for an individual in Lithuania, verified with Stripe's published test persona (not a real person), `losses_collector: "application"` as ADR-061's shape has it. Then:

| Step | Action | Result |
|---|---|---|
| 0 | Transfer to the account **while unverified** (`stripe_transfers: restricted`) | **Refused** — `insufficient_capabilities_for_transfer`. ADR-061 §3's rule is enforced by Stripe too, not only by us |
| a | Transfer 1000 to the verified account | Recipient `available = 1000` |
| b | Reverse **300** of the 1000 | **Accepted.** `amount_reversed = 300`, `reversed = false`. **Partial reversal is allowed** |
| d | Recipient pays out the remaining 700 to their bank | `available = 0` |
| e | Reverse the remaining **700** against an empty balance | **Accepted — no refusal, no error.** `amount_reversed = 1000`, `reversed = true` |
| f | Recipient's balance afterwards | **`available = −700`** |
| f | Recipient's balance transactions | `payment_refund −700 "REFUND FOR PAYMENT"`, `payout −700`, `payment_refund −300 "REFUND FOR PAYMENT"`, `payment +1000` |
| g | **Platform's** balance transactions, same moment | `transfer_refund +700`, then immediately **`reserve_transaction −700 "Reserved funds because of balance change on account"`** |
| h | Close the account with −700 outstanding | **Allowed.** The −700 reserve on the platform **persists after the account is closed** |

**Three findings, and the third is the one that decides the shape of every option.**

1. **A reversal never fails for insufficient funds.** Stripe does not ask whether the recipient still has the money; it takes it back and books the recipient negative.
2. **The recipient sees a refund, in those words**, on a balance that can go below zero. Nothing on their side says *"the platform clawed this back"*; it says *"REFUND FOR PAYMENT"*, negative.
3. **The platform pays the shortfall at the moment of reversal, not later.** The 700 came back to the platform balance and was reserved against the platform in the same second, because the account's `losses_collector` is the application. **A closed account does not release it.** Economically the reversal "succeeded" by moving the loss from Stripe's books to ours, instantly. **There is no configuration in which the money simply comes back from a waiter who has spent it.**

### What the Ledger does today, established by reading

`WalletProjectionService.recomputeBalance` is a signed sum over every `LedgerLine` — credits minus debits — with **no floor**. A `TIP_PAYABLE` debit larger than the credits produces a negative balance, and the projection reports it as such. THREAT_MODEL's entry *"A Wallet's Available balance can still be clawed back after the fact"* already records this as correct behaviour in Model A. **The Ledger can represent a waiter who owes; what it cannot do is collect.**

---

## The shortfall, named

Two weeks after a 20 € bill with a 5 € tip, the guest is refunded in full. Under ADR-023 the reversal is proportional: 5 € of tip must come back. Three states are possible for that 5 €:

- **still on the waiter's Stripe balance** — reversal takes it; the waiter's balance drops by 5 €; the Ledger's `TIP_PAYABLE` debit matches reality. **No shortfall.** This is the only case ADR-023 covers.
- **paid out, not yet spent** — same as above from Stripe's view: reversal succeeds, the waiter's Stripe balance goes to −5 €, the platform is reserved 5 €. The waiter has 5 € in a bank account that Stripe no longer counts.
- **paid out and spent** — identical to the previous row on every ledger. **The difference between "paid out" and "spent" is invisible to every system involved**, which is why the options below cannot depend on it.

**So the shortfall is: the platform is out the tip amount from the moment of reversal, and something has to decide who ultimately bears it and how the books say so.**

---

## Options — shown, not chosen

For each: what the Ledger says, what the waiter sees, what the restaurant sees, what it costs. **The Founder's four candidates plus two that fell out of the facts.** They are not exclusive; the last two are windows that reduce how often the first four are reached.

### Option 1 — The restaurant bears the tip refund in full

The guest's refund is funded by the restaurant, tip included; the waiter's account is never reversed.

- **Ledger:** `RESTAURANT_REVENUE_PAYABLE` is debited for the whole refund including the tip share; `TIP_PAYABLE` is **not** touched. ADR-023's proportional reversal is replaced, for the tip share, by an unconditional charge to the venue. **The Ledger stops saying the waiter's tip was refunded, because it was not.**
- **Waiter sees:** nothing. Their balance and history are unchanged. A tip stays a tip.
- **Restaurant sees:** a refund line larger than its own revenue share — the venue paid the guest back money it never received. **The screen must say so** or an owner will read it as an error.
- **Costs:** the venue, every time, by construction. Simplest Ledger. Commercially it is a rule the venue must agree to in advance — *"you underwrite your staff's tips against refunds"* — which is a Terms question and a pricing question. **It also removes the waiter's incentive to care about refund-prone service**, which some owners will name as unfair and some will accept as the price of never touching a person's money.

### Option 2 — Withhold from the waiter's future tips

The reversal is taken from Stripe as measured (recipient goes negative), and the platform recovers the shortfall by netting it against the waiter's next tips before they are transferred.

- **Ledger:** `TIP_PAYABLE` at that Membership is debited as ADR-023 already does; the Wallet balance goes negative and **stays negative until future credits cover it** — which the projection already represents. Transfers to the waiter are made only for the positive part of the balance. **The Ledger is true throughout: it says the waiter owes, and it says when they no longer do.**
- **Waiter sees:** a negative balance with a history line explaining which refund caused it, and tips that "do not arrive" until it is cleared. **This is the case THREAT_MODEL's clawback entry warns about**: silently showing a smaller total destroys trust in a wallet; the history has to carry the reason.
- **Restaurant sees:** nothing unusual — its own refund share, as today.
- **Costs:** the platform carries the shortfall **for as long as the waiter has no future tips** — a waiter who leaves, or has a bad month, never clears it. On Stripe's side the reserve sits until the recipient account is positive again, which a platform-side netting scheme does not achieve unless the platform *also* transfers into the negative account to zero it (and then nets the same amount out of the Ledger). **Two places have to agree — our Ledger and Stripe's recipient balance — and today only one of them exists.** The engineering is real: a netting step in the transfer path, and a "what happens on departure" rule that is Option 3 in disguise.

### Option 3 — Negative balance as a debt

Same reversal, but the negative balance is not a queue to be netted; it is a receivable the platform holds against a person.

- **Ledger:** as Option 2 — `TIP_PAYABLE` debited, Wallet negative. Whether a new account is needed to name it as a receivable (a `WAITER_RECEIVABLE` or similar) is a bookkeeping question, not a decision this ADR can make; the signed balance already carries the fact.
- **Waiter sees:** *"you owe €5.00"*. On Stripe's side, exactly that: `available = −5.00`, labelled a refund.
- **Restaurant sees:** nothing.
- **Costs:** **collecting from an individual is not something this platform is built to do**, and probably not something it should be: dunning a waiter for 5 € is a customer-support and reputational cost far above the money. Legally it is a claim against a private person arising from a contract the waiter accepted at onboarding — which means the onboarding Terms have to say it, in advance, and nobody has written them. **In practice this option is Option 2 with the departure case made explicit: the debt is real, and it is written off.**

### Option 4 — A window during which tips cannot be withdrawn

Tips are transferred to the waiter's Stripe account only after a hold — the dispute window, or a fixed number of days — so that a reversal within the window always finds the money.

- **Ledger:** `TIP_PAYABLE` credited at capture as today; `pendingBalance`, which ADR-024 left at zero because nothing was withdrawable, **becomes real**: pending until the window closes, available after. A refund inside the window debits pending; **ADR-023 works unchanged**, because the money is still in one place.
- **Waiter sees:** *"€5.00 pending, available on <date>"*. Stripe's own hosted balance would show nothing until the transfer happens.
- **Restaurant sees:** nothing unusual.
- **Costs:** **the waiter is paid late, every time, for everyone — to cover the rare case.** In a trade where tips are treated as cash at the end of the shift, a two-week or thirty-day hold is a product-defining decision, not a setting. It does not eliminate the shortfall: a refund after the window is Options 1–3 again, only rarer. **And it is the option that most changes the pitch:** *"tips by name, fixed at the moment of payment"* becomes *"…paid a month later."* Chargebacks can arrive up to 120 days after the charge; a window that covers them is not a window a waiter would accept.

### Option 5 — Reverse only what is there; the venue bears the rest *(fell out of the facts)*

A hybrid the live behaviour makes possible: the platform reads the recipient's balance before reversing, reverses **up to** what is available (partial reversal is allowed), and charges the remainder to the restaurant as in Option 1.

- **Ledger:** `TIP_PAYABLE` debited for the reversed part; `RESTAURANT_REVENUE_PAYABLE` debited for the rest. **Two debits for one refund, split by a fact about the waiter's balance at that second.** True, but it means the same refund produces a different Ledger shape depending on timing — which is the property that makes reconciliation hard to reason about.
- **Waiter sees:** a smaller drop than the tip, sometimes zero, with no clean explanation of why this refund cost them 2 € and the last one cost 5 €.
- **Restaurant sees:** a refund line that varies by something it cannot see.
- **Costs:** no negative recipient balances, ever, and no platform reserve. Paid for in explainability: **neither party can predict what a refund will cost them.**

### Option 6 — Platform absorbs, as a bounded provision *(fell out of the facts)*

Accept finding 3 as the design: the platform is `losses_collector`, the reserve is the cost of Model B, and it is priced into the platform fee as a provision rather than recovered from anyone.

- **Ledger:** `TIP_PAYABLE` debited as ADR-023 does; the shortfall is booked to a platform expense account (a new one — not decided here). **The Ledger says the waiter's tip was refunded and the platform paid for it.**
- **Waiter sees:** the tip reversed on the Ledger side, but **Stripe still books them negative** — so to make this option true on both books the platform must transfer the shortfall into the recipient account to zero it. Two calls per shortfall, and a Stripe history that reads *refund, then transfer*, which is honest.
- **Restaurant sees:** nothing.
- **Costs:** the platform, capped by a number nobody has: **realistic tip-refund exposure per venue over a dispute window.** MASTERPLAN's positioning section already names that number as missing. Without it this option is a blank cheque; with it, it may be the cheapest thing on this list.

---

## What every option needs, regardless of which is chosen

- **A refund and dispute procedure in writing before a live pilot** (MASTERPLAN, pilot limitations). This ADR is the design input for it, not a substitute.
- **The exposure number.** Options 1, 3, 4 and 6 are all priced by *how much tip money is refunded how long after payment*. Nobody has measured it, and no option should be chosen by feel against it.
- **The onboarding Terms for waiters.** Options 2 and 3 are claims against a person; they exist only if the person agreed to them at onboarding, in words that name the case.
- **Two books that must agree.** Whatever the Ledger says, Stripe's recipient balance says something too, and it does not read our Ledger. Any option that leaves a recipient negative on Stripe's side while our Ledger says otherwise has two truths, and reconciliation will report the difference forever.

---

## Boundaries

- **No code.** Nothing here changes `handleChargeRefunded`, `splitProportionally`, or the projection.
- **`PROCESSOR_CLEARING_CONTRA` is not touched** — it is the neighbouring open item in THREAT_MODEL and is orthogonal to this one.
- **The money fork is not built** (ADR-053, ADR-061). This ADR assumes it exists and asks what happens after.
- **Sandbox state after the experiment, stated:** one closed recipient account with −700 outstanding, and a `reserve_transaction −700` (test money, €7.00) that **persists** on the platform test balance. Recorded rather than tidied, because tidying it would mean transferring into a closed account, and whether that is even possible is a question for the option that needs it.
