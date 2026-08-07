---
title: THREAT_MODEL
version: 1.1.0
status: Active
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# THREAT_MODEL

> "A threat model that lists what you haven't built is more honest than one that only lists what you have."

Purpose: not a from-scratch security exercise — a single place collecting the threats this project has *already* decided how to handle, each pointing at the specific ADR that made the call, plus an explicit, dated list of what genuinely has no answer yet because the code it depends on doesn't exist. Requested after external review (ChatGPT), confirmed by the Founder as worth having now, in parallel with Sprint 3 — not a Sprint 3 deliverable itself, and not a reason to pause it.

Every entry below cites a real ADR number and a real, already-existing mechanism (migration, guard, service method, test) — never a restatement in different words of what the ADR already says. If this document and the cited ADR ever disagree, the ADR is the source of truth (`ARCHITECTURE_DECISIONS.md`'s own stated purpose) and this file is stale.

---

# Closed Threats

## 1. Duplicate financial side-effects from a replayed webhook or retried request
**Threat:** Stripe redelivers a webhook (its own retry policy, or a network blip on our side), or a client retries a timed-out request — either way, the same financial event could be processed twice, double-crediting a Ledger account.

**Closed by:** ADR-004 — Idempotency as a Stateful Record. *"Introduce an `idempotency_keys` table: key, endpoint scope, request fingerprint hash, status..., stored response snapshot, `expires_at`. Incoming webhooks are deduplicated the same way, keyed by the provider's own event id."*

**Mechanism:** `IdempotencyKey` table (`schema.prisma`), enforced at the API contract level (`API_Contract.md`, Idempotency section — required `Idempotency-Key` header on financial endpoints; Stripe webhooks deduplicated by the provider's own event id, not a client-supplied one). Not yet exercised by a real webhook handler (Sprint 5 is the first caller) — the mechanism is built, unused, same status as the Outbox (see `EVENT_CATALOG.md`).

---

## 2. An unbalanced Ledger posting reaching the database
**Threat:** A bug in application code — or a raw SQL script, a bad migration, a future service that bypasses `LedgerService` — writes a `JournalEntry` whose `LedgerLine` rows don't sum to zero across debits and credits, silently corrupting the one invariant the whole product's reconciliation story depends on.

**Closed by:** ADR-002 — Ledger as Source of Truth. Two independent layers, not one: the in-process write-helper (`assertBalanced`, `LedgerService.postJournalEntry`) rejects a bad posting before any database write; a Postgres deferred constraint trigger (`ledger_line_balanced` / `check_journal_entry_balanced()`, `apps/backend/prisma/sql/ledger_integrity.sql`) rejects it again at commit even if the first layer is bypassed entirely.

**Mechanism, verified live, not assumed:** `ledger-trigger.integration.spec.ts` writes `JournalEntry`/`LedgerLine` rows directly through Prisma Client, deliberately never calling `assertBalanced` — the trigger is the only thing standing between the bad posting and the database in that test, and it rejects it. Additionally reproduced by hand this session via raw SQL against a freshly migrated database (`SET CONSTRAINTS ledger_line_balanced IMMEDIATE` inside a transaction, unbalanced debit/credit → `ERROR: JournalEntry ... is unbalanced`).

---

## 3. A JournalEntry's compensating-entry pointer disagreeing with its own entry_type
**Threat:** A row claims `entry_type = 'refund_issued'` but carries a `chargeback_id` instead of a `refund_id` (or any other mismatched combination) — a data-integrity bug that would corrupt reconciliation and any downstream report keyed on `entry_type`.

**Closed by:** ADR-017 — Compensating-Entry FK Placement. *"At most one of `refund_id` / `chargeback_id` / `adjustment_id` should be set on a given row, matching `entry_type`... expressible as a plain single-row Postgres `CHECK` constraint (no deferred trigger needed, since it doesn't aggregate across rows)."*

**Mechanism, confirmed present in the live schema:** `journal_entry_compensating_fk_matches_type` `CHECK` constraint (confirmed via `\d journal_entry` against the migrated database this session) — enforces the full match table (`refund_issued` ⇒ `refund_id` set, others null; `chargeback` ⇒ `chargeback_id` set, others null; `adjustment` ⇒ `adjustment_id` set, others null; `payment_captured`/`tip_allocated`/`payout` ⇒ all three null) at the database level, not just in application code.

---

## 4. A stolen refresh token used in parallel with the legitimate session
**Threat:** An attacker obtains a refresh token (device compromise, log leak, etc.) and uses it. Rotation alone (revoking only the used token) doesn't distinguish "the legitimate client rotated normally" from "someone just replayed an already-superseded token" — the standard signature of a stolen token racing the real one.

**Closed by:** ADR-019 (revised) — Refresh Token Storage, family-wide reuse detection. *"A revoked family invalidates every token descended from that login, present or future, not just the one being replayed."*

**Mechanism, verified live against real HTTP endpoints, not only unit tests:** rotate → replay the old, already-rotated-out token → both that token and the newer, never-replayed one from the same family are rejected by `POST /auth/refresh`. The detection moment is distinguishable from an ordinary already-revoked rejection (`RefreshTokenReuseDetectedError`) and written to `AuditLog` as `refresh_token_reuse_detected` — confirmed live, correct `user_id`/`familyId`/IP/user-agent, no duplicate row on the subsequent rejection of the family's other token.

---

## 5. Credential-stuffing / brute-force login attempts
**Threat:** An attacker scripts repeated login attempts against `/auth/login` — either guessing one account's password, or testing a leaked credential list across many accounts.

**Closed by:** ADR-010 — Audit Logging and Rate Limiting Belong to Foundation. *"Baseline rate limiting is a global throttling module, tuned per endpoint later against the limits already specified in API_Contract. Both are built in Sprint 1, before Authentication."*

**Mechanism:** `@Throttle({ default: { limit: 10, ttl: 60_000 } })` on `AuthController` (API_Contract.md, Rate Limiting: "Authentication 10/min" — stricter than the global 100/min default). Verified live this session, fresh database, real HTTP: 10 requests allowed, the 11th rejected `429`, both the 401s and the 429 correctly written to `AuditLog` after this session's own AuditLog failure-channel fix.

---

## 6. Platform absorbing a restaurant's own fraud and chargeback losses
**Threat:** Every restaurant's Connect account carries its own fraud/chargeback risk. Left unexamined, the platform could end up contractually on the hook for losses caused by a restaurant's own customers or business practices — a real balance-sheet exposure, not an abstract one.

**Closed by:** ADR-014 (revised) — Stripe Connect Account Type: Standard-equivalent. *"The restaurant — not Hospitality OS — bears its own fraud and chargeback losses, the financially conservative default for a platform whose own margin is a small take rate."*

**Mechanism, confirmed empirically, not by reading Stripe's documentation:** a real `POST /v2/core/accounts` 2×2 matrix this session showed `dashboard: "express"` *only* accepts `losses_collector: "application"` (platform absorbs losses) and is rejected (`HTTP 400`) with `losses_collector: "stripe"`; `dashboard: "full"` is the exact mirror. There is no configuration where the platform can be on the hook while using the account type actually implemented.

---

## 7. Repeated failed payments as an invisible fraud signal
**Threat:** `MASTERPLAN.md`'s Fraud Prevention section requires detecting "repeated failed payments" as a signal — impossible if a failed payment attempt is never recorded as having failed.

**Closed by:** ADR-018 — Payment Mutability. *"`failed` (a processing error or timeout) and `declined` (the card issuer explicitly rejected the charge) are kept as two distinct terminal states rather than one, because they are different fraud signals in practice."*

**Mechanism:** `Payment.status` transitions exactly once from `pending` to a terminal state including `DECLINED` (added to `PaymentStatus` by this ADR), recorded via `updated_at`; every other field on `Payment` stays immutable. Not yet exercised by a real webhook handler (Sprint 5) — the schema and the rule are in place; nothing writes a `Payment` row yet.

---

# Accepted Risk (Not Closed — Deliberately Left Open)

## Redis flush silently un-revokes outstanding refresh tokens and token families
**Risk:** If Redis is flushed or lost (crash without persistence, manual `FLUSHALL`, infrastructure failure), every revoked `jti` and revoked `familyId` disappears. A previously-stolen-and-revoked refresh token would once again verify successfully by signature until its own natural expiry (up to 7 days, `JWT_REFRESH_TTL_SECONDS`).

**Recorded in:** ADR-019, Consequences. *"Accepted risk, unchanged from the original decision: a Redis flush would silently un-revoke every outstanding refresh token and family flag (they'd still verify by signature until natural expiry, typically within days) — acceptable for MVP; revisit if refresh-token revocation ever needs to survive a Redis outage."*

This is listed here, separately from the Closed Threats above, on purpose: it is a threat the Founder and this project have knowingly chosen to accept for MVP, not one that has a mitigation in place. Revisiting it is an explicit future decision, not a bug.

---

# Open, Not Answered

Genuinely unanswered — not because no one has thought about them, but because the code they'd be answered by doesn't exist yet. Listed honestly rather than filled in with a guess, per the Founder's own instruction. Each becomes answerable at Sprint 5 (Payments & Ledger, `IMPLEMENTATION_PLAN.md`) — the sprint where a real Payment Intent, a real Stripe webhook handler, and the first real `LedgerService` caller are actually built.

## Stripe unreachable at the moment of payment
What the terminal shows the customer, what state the `Payment` row ends up in, and whether/how the flow retries — all depend on the real Payment Intent + webhook code that Sprint 5 builds. No answer exists today because there is no `POST /payments` handler to have an answer.

## Bank or card issuer (EMI) timeout during confirmation
Distinct from Stripe itself being down: Stripe is reachable, but the customer's own bank or e-money issuer doesn't respond to the authorization request in time. Whether this surfaces as `Payment.status = FAILED` (ADR-018 already has the state for it) versus something needing its own handling depends on Sprint 5's actual webhook-handling code, not written yet.

## Webhook and client-side confirmation diverging by more than the expected lag
ADR-015 already establishes the *normal* case: the customer's receipt shows immediately (client-side), the Ledger write happens asynchronously via webhook a moment later — an intended, short eventual-consistency gap, not a defect. Genuinely open: what happens if that gap grows far past normal (webhook lost, delayed by Stripe, or never arrives at all) — does the customer's receipt ever get contradicted, does staff get an alert, is there a reconciliation sweep. ADR-015 answers the expected case; it does not answer the pathological one, and no code answers it either yet.

## Whether the platform fee is clawed back on refund
See ADR-021's own "Known follow-up" and "Founder's stated direction" — a real question surfaced by Sprint 5's fee split, not yet answered in code.

---

# Final Principle

A threat model that only ever grows entries and never grows an "open" section stops being trustworthy at exactly the moment it stops being honest about what hasn't been built. Money moves through this system starting Sprint 5 — that's when every item in "Open, Not Answered" above needs to move up into "Closed Threats," cited against whatever ADR ends up answering it, not silently disappear.
