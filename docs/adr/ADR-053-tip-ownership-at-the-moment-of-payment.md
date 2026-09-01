---
title: ADR-053 — Tip ownership at the moment of payment
version: 1.0.0
status: Accepted — Model A built and running; Model B is the target, blocked on a written legal answer
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-053 — Who owns the tip at the moment of payment

**Status:** Accepted (Sprint 14). Model A is built and is what the pilot runs on. Model B is the target product model and is blocked on a written answer from outside this project.

---

## Context — a question nobody asked

**No ADR has ever decided who owns a tip at the moment the customer pays.**

ADR-014 chose the Stripe account type and settled who bears fraud and chargeback losses. ADR-022 described how a tip is *accounted for* inside a payment that was already, by then, a single charge. **Ownership fell out as a consequence of the payment being single — it was never put as a question and never answered.**

That is not negligence. It is the shape a question takes when every document downstream of an early decision inherits its premise: once the charge is one charge on the venue's account, "whose money is the tip" stops looking like an open question and starts looking like a settled fact about plumbing.

**It is live now because three pieces of current work all depend on the answer:** `Withdrawal`, `PROCESSOR_CLEARING_CONTRA` (ADR-032 Decision 1 records its correct future shape), and closing a venue (ADR-054). Each needs to know whether an unpaid tip is the venue's liability to a person, or that person's money sitting in the venue's account.

---

## The two models

### Model B — the target product model

**At the moment of payment the sum separates.** The bill goes to the venue's account. **The tip goes directly to the waiter's own account.** The venue never receives it, never holds it, and never distributes it.

This is what the product is *for*. A waiter's tips are not the restaurant's money at any point, and the product that says so most plainly is the one where they never arrive there.

### Model A — what is built, and what the pilot runs on

**A single Direct charge for the whole amount lands on the venue's connected account** (ADR-014). The waiter's share is recorded in the Ledger as a `TIP_ALLOCATED` entry crediting `TIP_PAYABLE` against that waiter's `membership_id`. The venue owes the waiter; the Ledger says by how much.

**Model A is not a rejected alternative and it is not a fallback.** It is a deliberate bootstrap: the model that can be built, run, and put in front of a real restaurant while the question that gates B is answered by people who are not us.

---

## The observation this ADR exists to record

**The `tip_payable` Ledger line, carrying `membership_id`, is identical under both models.**

The obligation to the waiter arises the same way, in the same account, for the same amount, at the same moment. `Wallet` is a projection over those lines, and **a projection does not care how the obligation is discharged.**

**The difference between A and B is only the method of settlement** — wages paid by the venue, or a Stripe transfer that already happened. Everything before settlement is the same system:

Ledger and its six accounts · both portals · authentication and RBAC · `Membership` · refund and chargeback accounting · GDPR mechanisms · agreements and acceptance · the design system.

**Consequence, and it is the reason this is Accepted rather than Proposed: the product is built all the way up to settlement without waiting for the answer.** Nothing above that line is speculative work, and nothing above it has to be redone if B is chosen.

---

## The legal position, as far as it is actually established

**Model A: settled, and there is no open legal question in it.** VMI's position is that tips distributed by the employer are an element of employment income, and the tax agent is the restaurant. That is a complete answer for the model that is built.

**Model B: nobody has an answer.** Not VMI, not us. The question of what a platform is doing when it moves money from a customer directly to a named individual, and who is the tax agent for it, has not been answered by anyone we have asked.

**Two requests are sent and outstanding:** VMI, and the Bank of Lithuania's Newcomer Programme.

### Blocked until a written answer arrives

- Splitting the funds at the moment of payment.
- Waiter onboarding with KYC.
- `Withdrawal` implemented as a transfer.

**The money flow is not to be touched before one of those answers is in writing.**

### Condition for revisiting

A written answer from **either** body. It is recorded **verbatim**, and **with its boundaries stated** — which question it answers and, explicitly, which it does not. An answer paraphrased into what we hoped it said is worse than no answer, because it cannot be checked afterwards.

---

## Consequences — three places where Model B is expensive

These are not arguments against B. They are what B costs, recorded now so the cost is known before the answer arrives rather than discovered after it.

**1. The waiter must pass KYC at Stripe.** A person who started a shift this morning cannot receive a tip this evening. Model A has no such gate: the venue owes them from the first table they serve. This is a real product cost on the one interaction the product exists to improve.

**2. Refunds invert.** Under A, a refund adjusts an obligation the venue has not yet paid. Under B the money is already in the waiter's own account and **must be clawed back from a person who may have spent it.** A negative balance on a natural person's account is not an accounting artefact — it is a debt owed by a human being, and every mechanism for pursuing or forgiving it is a thing this product would then have to have.

**3. The platform's role changes.** Initiating transfers to natural persons is a different activity from routing a card payment to a merchant, and it is precisely the difference the Bank of Lithuania was asked about.

**Estimated rework if B is chosen: three to four weeks**, across ADR-014 (account topology), ADR-022 (tip accounting), ADR-023, `Wallet`, and waiter onboarding.

---

## What no AI established here, stated explicitly

**No AI — this one included — establishes the content of Lithuanian tax or payment law.** Everything legal in this document came from the Founder or from a body that was asked directly, and where nothing came back, this document says so instead of filling the gap.

**Two documented cases in this project, both recent:**

- The working hypothesis that tips would attract **GPM at 15%** was wrong. It was plausible, it was stated with confidence, and it was not a fact.
- **Claude.ai and ChatGPT independently produced the same incorrect claim** about a Stripe acceptance requirement. Reading Stripe's own documentation refuted it.

**Two AIs agreeing is not confirmation. It is one error, arrived at twice** — most likely from the same training material — and it is more dangerous than one AI being wrong alone, because agreement reads as corroboration.

The rule this project takes from it: **a legal or vendor claim is established by a written answer from the body that owns it, or by executing against the vendor's own API — never by two models concurring.**
