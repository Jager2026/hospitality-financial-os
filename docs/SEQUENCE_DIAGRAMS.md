---
title: SEQUENCE_DIAGRAMS
version: 1.0.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# SEQUENCE DIAGRAMS

Purpose: show the exact order and timing of the flows where `DATABASE.md`, `API_Contract.md`, and `SYSTEM_ARCHITECTURE.md` describe the pieces but never pinned down the sequence they run in. The actual diagrams live as separate `.mermaid` files:

- `SEQUENCE_PAYMENT_TIP.mermaid`
- `SEQUENCE_ONBOARDING.mermaid`
- `SEQUENCE_REFUND_CHARGEBACK.mermaid`

This document explains what each one settles, and the three new ADRs they produced. Two candidates from the original list of five are intentionally not here.

---

# Why only three, not five

**Employee Invitation** isn't included. It's a linear invite → accept flow with no webhook, no asynchronous step, no financial write — nothing a sequence diagram surfaces that `DATABASE.md` and `API_Contract.md` don't already say. One real edge case did turn up while checking it: what happens when the invited email already belongs to a User — someone already working at another restaurant on the platform? That's now a one-line rule in `DATABASE.md`'s Membership entity, not a diagram.

**Wallet Withdrawal** isn't included either, on principle. It's explicitly `Future` in every document that mentions it — `API_Contract.md`, `MASTERPLAN.md`, `IMPLEMENTATION_PLAN.md`. A production-grade diagram for a feature that isn't being built yet is the same mistake as documenting for its own sake, aimed at a different kind of artifact. Revisit when Withdrawal actually enters scope.

---

# What each diagram resolves

## Payment + Tip Flow

The question that mattered most: does the customer's receipt wait for the Ledger, Outbox, and Wallet to finish, or does it show immediately?

**Resolved: the receipt shows immediately**, driven by Stripe.js's client-side confirmation, not by the backend's webhook processing. The Ledger write, Tip allocation, and every downstream projection — Wallet, Restaurant balance, Analytics — are triggered by the webhook, which can legitimately arrive a second or two after the client already saw success. This is exactly the eventual-consistency behavior ADR-002 and ADR-006 already designed Wallet to tolerate, not a bug to fix. See ADR-015.

Also resolved in the diagram itself: duplicate webhook delivery, where the idempotency check happens, and Outbox Worker crash recovery.

## Restaurant Onboarding

Settles which Stripe Connect account type to use — Express. Stripe hosts the KYC and bank-details forms directly, so none of that ever touches our servers, and a second location repeats the entire sequence independently (ADR-009 already established the independence; this diagram makes the repetition explicit). See ADR-014.

## Refund / Chargeback

Surfaced a real gap: the six-account chart of accounts in `DATABASE.md` (ADR-002) has nowhere to put money that's disputed but not yet resolved. The honest options were adding a seventh account for funds pending resolution, or, for MVP, treating a new dispute as provisionally lost and reversing that entry if it's later won. Chose the second — simpler, and chargebacks won are the minority outcome. See ADR-016.

---

# New ADRs from this pass

Three genuine architecture decisions came out of walking through the timing, not from re-describing decisions already made:

- **ADR-014** — Stripe Connect account type: Express
- **ADR-015** — Receipt timing: client-side confirmation; Ledger and projections update asynchronously
- **ADR-016** — Chargeback handling: provisional-loss-then-reverse, no dedicated held-funds account for MVP

This is the exercise doing what it was meant to do — producing new decisions, not reformatting old ones.
