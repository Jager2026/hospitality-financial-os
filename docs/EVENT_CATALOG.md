---
title: EVENT_CATALOG
version: 1.0.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# EVENT_CATALOG

> "An event that isn't written down is a rumor, not a contract."

Purpose: the concrete catalog of `OutboxEvent` rows this codebase actually produces today, and their exact payload shape — as opposed to `ARCHITECTURE_DECISIONS.md` (ADR-003), which explains *why* the Outbox exists, and `SYSTEM_ARCHITECTURE.md`, which describes the mechanism and intended consumers in prose. Everything below is read directly from `apps/backend/src/ledger/ledger.service.ts` and `apps/backend/prisma/schema.prisma` at the time of writing, not designed ahead of the code. Requested after external review (ChatGPT), confirmed by the Founder as worth having now, in parallel with Sprint 3 — not a Sprint 3 deliverable itself.

External review triggered this: an event catalog is a reasonable thing to expect once a codebase has an event mechanism at all, and this one has had one, unused, since Sprint 1.

---

# The Envelope

Every row in `outbox_event` (`apps/backend/prisma/schema.prisma`) has exactly this shape — this part is fixed infrastructure, not per-event:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `aggregate_type` | String | Which kind of entity this event is about |
| `aggregate_id` | UUID | That entity's own id |
| `event_type` | String | See below — the only per-event-kind field |
| `payload` | JSON | See below |
| `created_at` | timestamp | |
| `published_at` | timestamp, nullable | Set once a consumer has handled it; `null` = still pending |
| `attempts` | int, default 0 | Incremented by the poller on every dispatch attempt |

Written in the **same database transaction** as the Ledger write it describes (ADR-003) — confirmed directly in `LedgerService.postJournalEntry`, not just asserted by the ADR text.

---

# Events Currently Produced

There is exactly **one write path** into `outbox_event` in this codebase today: `LedgerService.postJournalEntry`. It is generic across all six `JournalEntryType` enum values (`schema.prisma`), not six separate hand-written cases — the event's shape is a formula, not a lookup table:

```typescript
await tx.outboxEvent.create({
  data: {
    aggregateType: "JournalEntry",
    aggregateId: entry.id,
    eventType: `journal_entry.${input.entryType.toLowerCase()}`,
    payload: { journalEntryId: entry.id, entryType: input.entryType },
  },
});
```

Applying that formula to every value of `JournalEntryType` gives the complete, current set of possible `event_type` strings:

| `entry_type` (DB value) | `event_type` produced | Fires when |
|---|---|---|
| `payment_captured` | `journal_entry.payment_captured` | A payment is captured and posted to the Ledger (Sprint 5, first real caller) |
| `tip_allocated` | `journal_entry.tip_allocated` | A tip is allocated to one or more Membership wallets (Sprint 6) |
| `refund_issued` | `journal_entry.refund_issued` | A refund's compensating entry is posted (Sprint 5) |
| `chargeback` | `journal_entry.chargeback` | A chargeback's provisional-loss entry is posted (Sprint 5, ADR-016) |
| `adjustment` | `journal_entry.adjustment` | A manual balance correction is posted |
| `payout` | `journal_entry.payout` | A payout to a Restaurant's or Membership's external account is posted |

**Payload shape**, identical for all six — deliberately thin:

```json
{ "journalEntryId": "<uuid>", "entryType": "PAYMENT_CAPTURED" }
```

`entryType` here is the raw Prisma enum member (uppercase, e.g. `"PAYMENT_CAPTURED"`), not the lowercased string used in `event_type` — the two are related but not identical strings; a consumer matching on `event_type` should not assume `payload.entryType` is already lowercase.

The payload is intentionally minimal — an id and the entry's own type, not a denormalized copy of the JournalEntry/LedgerLine rows. A consumer that needs the full picture (which LedgerLines, which Restaurant, which Membership) re-reads `JournalEntry`/`LedgerLine` by `journalEntryId` at dispatch time, rather than trusting a payload that could grow stale between write and dispatch. This isn't written down anywhere else — it's the natural reading of the payload actually being this thin, not a separate design decision with its own ADR.

**Nothing has produced one of these rows outside a test yet.** `LedgerService.postJournalEntry` has no real caller in application code today (Sprint 5 is the first) — the six rows above describe what the *mechanism* would write once something calls it, not events that have actually fired in a running system.

---

# Consumers

`OutboxPollerService` (`apps/backend/src/outbox/outbox-poller.service.ts`) polls every 2 seconds (`SEQUENCE_PAYMENT_TIP.md`: "Every 1-2 seconds") for rows where `published_at IS NULL`, and currently does exactly one thing with each: increments `attempts` and logs a debug line — "no handler registered yet." No projection reads an event and updates anything. This is a deliberate skeleton (IMPLEMENTATION_PLAN.md, Sprint 1), not an oversight: `SYSTEM_ARCHITECTURE.md` names the intended eventual consumers —

- Wallet Module → updates the affected Wallet's cached balance (Sprint 7)
- Restaurant Module → updates the affected Restaurant's cached balance
- Analytics Module → updates its read models (Sprint 9/10)
- Notification Module (future) → sends alerts

— but none of these modules exist yet, so none is wired in. `dispatch()`'s body, not its polling shape, is what changes when the first real handler lands.

A row whose `attempts` reaches 5 without `published_at` being set logs an operational alert (`SYSTEM_ARCHITECTURE.md`, Outbox Lag) rather than retrying forever. Since nothing currently ever sets `published_at`, every real event this mechanism produces will eventually cross that threshold and alert — expected and harmless while there are zero consumers, since zero events are being produced in application code either; worth remembering not to be alarmed by it appearing in logs the moment Sprint 5 starts writing real events, before Sprint 7 gives it a consumer to actually satisfy.

---

# Not Yet Cataloged

No event types beyond the six above are defined anywhere in code. Per the Founder's explicit instruction: this document does not invent event shapes for Sprint 5+ functionality that doesn't exist yet (a `payment_intent.succeeded` webhook handler, a `RestaurantCreated` event for the Sprint 3 module that just shipped, or anything else). `SYSTEM_ARCHITECTURE.md` names some of these in passing as historical color ("Previous versions of this document referenced domain events (RestaurantCreated, PaymentCompleted, TipCreated, WalletUpdated, TransactionRecorded) without specifying how they were delivered") — none of those are real `event_type` strings today, and none should be treated as planned ones until real code writes them. When Sprint 5 (or any later sprint) adds a real writer with a new shape, extend this table then, from the code that exists at that point — not now, from a guess.

---

# Final Principle

This catalog is a description of what the code does, refreshed when the code changes — not a specification the code should eventually catch up to. If this document and `ledger.service.ts` ever disagree, the code is right and this file is stale.
