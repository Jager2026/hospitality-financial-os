---
title: DOMAIN_GLOSSARY
version: 1.0.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# DOMAIN GLOSSARY

> One page, one meaning per term. Nothing here is a new decision — every definition is a direct compilation from `DATABASE.md`, `ARCHITECTURE_DECISIONS.md`, and `MASTERPLAN.md`. If this page ever disagrees with those, they win and this page is stale.

Purpose: the same word means the same thing to every engineer, every sprint, forever. Most confusion six months into a project comes from two people quietly meaning different things by the same noun — this page exists so that never happens here.

---

# Confusable Pairs

The fastest way to misuse this domain model is to treat one of these as a synonym for the other. They are not.

- **Payment ≠ Transaction** — a Payment is an *attempt*. It can fail. A Transaction only exists once a Payment succeeds.
- **JournalEntry ≠ LedgerLine** — a JournalEntry is the header of one financial event. A LedgerLine is one debit or credit inside it. You never have one without the other.
- **Wallet ≠ Ledger** — the Ledger is the source of truth. Wallet is a cached *projection* of it. If they ever disagree, the Ledger is right and Wallet is rebuilt.
- **Membership ≠ Employee** — `Membership` is the database's name for "this person's role at this restaurant." The product itself still says "your team," "your waiter," "your manager" — nothing user-facing changes.
- **Organization ≠ Restaurant** — Organization is the legal/commercial group. Restaurant is one specific, physical, tax-registered location inside it. A single-location business is still "an Organization of one," even though the owner never sees that word.
- **Refund ≠ Adjustment** — a Refund reverses money because of a customer or card-network action. An Adjustment corrects a mistake for any other reason, and always requires a human and a stated reason.
- **Audit Log ≠ Ledger** — the Ledger records money. The Audit Log records *actions* — who did what, not what it was worth.

---

# Money & Ledger

**Payment** — one attempt to capture money from a customer through the processor. Can fail, decline, or time out. Is not a sale by itself.

**Transaction** — the business-level record that a sale completed. Created only once a Payment succeeds. Never stores the money breakdown itself (no `restaurant_amount`, no `tip_amount`) — those live only in the Ledger, under this Transaction's JournalEntry.

**Ledger** — the collective name for JournalEntry + LedgerLine together. The single source of truth for every movement of money in the system. Immutable: corrections are new rows, never edits.

**JournalEntry** — one balanced financial event — a payment captured, a refund issued, a tip allocated. The header row of a double-entry posting.

**LedgerLine** — one debit or credit inside a JournalEntry. The actual movement: an amount, an account, and — where it credits a specific person — a Membership.

**Wallet** — a person's balance, scoped to one Membership (not to a User directly, since two employers' money should never share a balance). A projection of the Ledger, not a second source of truth. Fully rebuildable at any time from LedgerLine alone.

**Tip** — the gratuity event a customer chose, tied to one Transaction. Its distribution to one or more people is expressed as LedgerLine rows — never a field on Tip itself, which is what makes pooled or split tips possible later without a schema change.

**Refund** — a reversal of part or all of a Transaction, initiated by the customer or staff. Never edits the original JournalEntry — always a new one, with LedgerLines that reverse the original and post to a contra account.

**Chargeback** — a card-network dispute against a Transaction. Same compensating-entry rule as Refund; the difference is who initiated it and why.

**Adjustment** — a manual correction that is neither a Refund nor a Chargeback (e.g., fixing a misallocated tip). Requires a stated reason and a named human — never an anonymous balance edit.

**Currency** — a reference row: code, exponent, name. Every amount elsewhere in the system is minor units of some Currency. Never assume the exponent is 2 — it isn't, for every currency.

---

# Organizations & People

**Organization** — the legal/commercial group. Owns one or more Restaurants. Created automatically the moment the first Restaurant is created; the founding Owner receives an org-wide Membership at that same instant.

**Restaurant** — one physical, legal, tax-registered business location. Carries its own VAT number, company number, and its own Stripe Connect account.

**User** — an authentication identity. Nothing more. A User with zero Memberships is a valid state (someone mid-invitation).

**Membership** — one person's role at one Restaurant, or — when `restaurant_id` is null — an org-wide role spanning every Restaurant in that Organization. One User can hold many Memberships, at different Restaurants, even in different Organizations.

**Role / Permission / RolePermission** — what a Membership is allowed to do. Entirely data-driven through the RolePermission table; no permission check anywhere should hardcode a role by name.

---

# Reliability

**OutboxEvent** — a durability record. Written in the exact same database transaction as a Ledger write, so a projection (Wallet, Restaurant balance, Analytics) can never silently miss an update, even across a crash.

**IdempotencyKey** — a stateful record that stops the same financial request from having a side effect twice. The same key with the same request returns the original stored response; the same key with a different request is rejected as a conflict.

**AuditLog** — a permanent, append-only record of who did what, when, from where. Never edited, never deleted.

---

# A Note on Precision

If a new term needs adding here, it already has a home first: a `Purpose` line in `DATABASE.md` for an entity, or a `Decision` in `ARCHITECTURE_DECISIONS.md` for a mechanism. This document only ever copies the definition forward — it never originates one. That is what keeps it from drifting.
