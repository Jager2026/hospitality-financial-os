---
title: EVENT_CATALOG
version: 1.1.0
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
| `payment_captured` | `journal_entry.payment_captured` | **Real, live** — `WebhooksService`'s `payment_intent.succeeded` handler (Sprint 5, shipped) |
| `tip_allocated` | `journal_entry.tip_allocated` | Not yet implemented — no code path exists (Sprint 6, Tips) |
| `refund_issued` | `journal_entry.refund_issued` | **Real, live** — `WebhooksService`'s `charge.refunded` handler (Sprint 5, shipped) |
| `chargeback` | `journal_entry.chargeback` | **Real, live** — two separate call sites in `WebhooksService`: `charge.dispute.created` (provisional loss) and, if the dispute is later won, `charge.dispute.closed` (reversal) — ADR-016's own documented one-`Chargeback`-to-many-`JournalEntry` shape, not a hypothetical |
| `adjustment` | `journal_entry.adjustment` | Not yet implemented — no code path exists |
| `payout` | `journal_entry.payout` | Not yet implemented — no code path exists (`Withdrawal`/`Settlement` are Future Entities, `DATABASE.md`) |

**Payload shape**, identical for all six — deliberately thin:

```json
{ "journalEntryId": "<uuid>", "entryType": "PAYMENT_CAPTURED" }
```

`entryType` here is the raw Prisma enum member (uppercase, e.g. `"PAYMENT_CAPTURED"`), not the lowercased string used in `event_type` — the two are related but not identical strings; a consumer matching on `event_type` should not assume `payload.entryType` is already lowercase.

The payload is intentionally minimal — an id and the entry's own type, not a denormalized copy of the JournalEntry/LedgerLine rows. A consumer that needs the full picture (which LedgerLines, which Restaurant, which Membership) re-reads `JournalEntry`/`LedgerLine` by `journalEntryId` at dispatch time, rather than trusting a payload that could grow stale between write and dispatch. This isn't written down anywhere else — it's the natural reading of the payload actually being this thin, not a separate design decision with its own ADR.

**No longer hypothetical: three of the six rows above are real, live traffic.** Sprint 5 (Payments & Ledger) shipped `WebhooksService` as `LedgerService.postJournalEntry`'s first real caller — confirmed directly in `apps/backend/src/webhooks/webhooks.service.ts`, not assumed from the sprint being marked done. Every real Stripe `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`, and `charge.dispute.closed` webhook this system receives today writes a real `JournalEntry`/`LedgerLine`/`OutboxEvent` row through this exact mechanism. `tip_allocated`, `adjustment`, and `payout` remain genuinely unimplemented — no code path produces them yet — and stay accurately described as hypothetical until a real sprint builds one.

---

# Consumers

`OutboxPollerService` (`apps/backend/src/outbox/outbox-poller.service.ts`) polls every 2 seconds (`SEQUENCE_PAYMENT_TIP.md`: "Every 1-2 seconds") for rows where `published_at IS NULL`, and currently does exactly one thing with each: increments `attempts` and logs a debug line — "no handler registered yet." No projection reads an event and updates anything. This is a deliberate skeleton (IMPLEMENTATION_PLAN.md, Sprint 1), not an oversight: `SYSTEM_ARCHITECTURE.md` names the intended eventual consumers —

- Wallet Module → updates the affected Wallet's cached balance (Sprint 7)
- Restaurant Module → updates the affected Restaurant's cached balance
- Analytics Module → updates its read models (Sprint 9/10)
- Notification Module (future) → sends alerts

— but none of these modules exist yet, so none is wired in. `dispatch()`'s body, not its polling shape, is what changes when the first real handler lands.

A row whose `attempts` reaches 5 without `published_at` being set logs an operational alert (`SYSTEM_ARCHITECTURE.md`, Outbox Lag) rather than retrying forever. Since nothing currently ever sets `published_at`, this is no longer a future concern to remember — it is happening now: every real `payment_captured`/`refund_issued`/`chargeback` row Sprint 5's live webhook traffic writes today crosses that threshold and logs an error, on a schedule (`MAX_ATTEMPTS_BEFORE_ALERT * POLL_INTERVAL_MS`, currently 5 × 2s = 10s after creation), because Sprint 7 hasn't given the Outbox a consumer yet. Expected, not a bug — but genuinely live log noise in the current system today, not a hypothetical for later, and worth knowing about before treating an `OutboxEvent` error-level log line as a real incident during this gap.

---

# Not Yet Cataloged

No event types beyond the six above are defined anywhere in code. Per the Founder's explicit instruction: this document does not invent event shapes for future functionality that doesn't exist yet — a `TipAllocated`-driven Wallet-projection event, a `RestaurantCreated` event, or anything else no current code path writes. `SYSTEM_ARCHITECTURE.md` names some of these in passing as historical color ("Previous versions of this document referenced domain events (RestaurantCreated, PaymentCompleted, TipCreated, WalletUpdated, TransactionRecorded) without specifying how they were delivered") — none of those are real `event_type` strings today, and none should be treated as planned ones until real code writes them. When Sprint 6 (Tips) or any later sprint adds a real writer with a new shape, extend this table then, from the code that exists at that point — not now, from a guess.

---

# Final Principle

This catalog is a description of what the code does, refreshed when the code changes — not a specification the code should eventually catch up to. If this document and `ledger.service.ts` ever disagree, the code is right and this file is stale.
