---
title: DATABASE
version: 2.4.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
supersedes: DATABASE.md v1.0 — see ARCHITECTURE_DECISIONS.md for the reasoning behind every change below
---

# DATABASE

> "The database is the memory of the company."

Purpose: define the complete data model of the Hospitality Financial Operating System. Every entity below implements one or more decisions recorded in `ARCHITECTURE_DECISIONS.md` — that document explains *why*; this document defines *what*. Where the two ever appear to disagree, `ARCHITECTURE_DECISIONS.md` wins and this file is out of date.

---

# Database Philosophy

Every table represents a real-world entity, or a technical necessity that a signed-off ADR requires — never a table created because code found it convenient. Never soft delete a financial fact. Never let two tables silently hold the same amount as if either could be authoritative.

---

# Database Principles

Every table must have:
- UUID Primary Key
- `created_at` / `updated_at`
- Soft Delete, where the business needs recovery (see "Soft Deletes")
- Indexes on every foreign key and every frequently filtered column
- Validation Rules

Every table that records a financial fact is immutable. Corrections are new rows — a new `JournalEntry`, a new `Refund`, a new `Adjustment` — never an edit to history.

---

# Core Domain

Twenty entities. Ten existed in v1.0. Ten were added directly by `ARCHITECTURE_DECISIONS.md` to close gaps the Sprint 0 review found — this is the schema catching up with already-agreed architecture, not scope creep.

`Organization` · `Restaurant` · `User` · `Membership` · `Role` · `Permission` · `RolePermission` · `Currency` · `Wallet` · `Payment` · `Transaction` · `JournalEntry` · `LedgerLine` · `Tip` · `Refund` · `Chargeback` · `Adjustment` · `OutboxEvent` · `IdempotencyKey` · `AuditLog`

---

############################################################
# ENTITY
Organization
############################################################
**Purpose:** The legal/commercial group that owns one or more restaurants. A single independent restaurant is still an Organization of one — the owner never has to think about this for a single-location business.

**Fields:** id, name, status, created_at, updated_at

**Relationships:** Organization → many Restaurant · Organization → many Membership (org-wide roles)

**Rules:** Every Restaurant belongs to exactly one Organization. Created automatically alongside the first Restaurant during onboarding, at which point the creating User receives an org-wide Membership (`restaurant_id IS NULL`) immediately — not a restaurant-scoped one. This is what makes adding a second Restaurant later a zero-friction action (ADR-005): the Owner already has access before that Restaurant exists.

---

############################################################
# ENTITY
Restaurant
############################################################
**Purpose:** One hospitality business location — the legal and tax entity.

**Fields:** id, organization_id, name, legal_name, company_number, vat_number, email, phone, country, currency, default_customer_locale, timezone, address, logo_url, status, stripe_account_id, onboarding_status, card_payments_status, payouts_status, requirements_due, created_at, updated_at

**Relationships:** Restaurant → Organization (parent) · Restaurant → many Membership · Restaurant → many Payment / Transaction

**Rules:** Restaurant carries `vat_number` and `company_number` because it is the tax entity, and for MVP owns its own Stripe Connect account (ADR-009, ADR-014 — Accounts v2, `dashboard: "full"`) — connected accounts are attached per location, not per Organization. `country` / `currency` mirror the connected account's fixed values; changing a restaurant's operating country means a new Stripe account, never an edit to this row. `default_customer_locale` is what the payment terminal shows before a customer touches anything — the customer has no account to store a preference in, so this is the only place it can live (ADR-013). Restaurant is never physically deleted. `currency` references `Currency.code`.

`card_payments_status` and `payouts_status` mirror Stripe's own v2 capability-status strings (`configuration.merchant.capabilities.card_payments.status` and `configuration.merchant.capabilities.stripe_balance.payouts.status` respectively — confirmed against a real API response, ADR-009's revision) — not booleans, and deliberately not a Postgres enum either, since this vocabulary belongs to Stripe and can grow without a migration on our side. `requirements_due` stores Stripe's real `requirements.entries[]` array as-is (JSON) — a list of requirement objects, not requirement-name strings.

---

############################################################
# ENTITY
User
############################################################
**Purpose:** Authentication identity.

**Fields:** id, email, password_hash, email_verified, two_factor_enabled, locale, last_login, status, created_at, updated_at

**Relationships:** User → many Membership (across Organizations and Restaurants)

**Rules:** Email unique. Passwords never stored in plaintext or logged. A User with zero Memberships is valid (mid-invitation). `locale` is the language this person sees the Restaurant Portal or Waiter Portal in — English or Lithuanian at MVP (ADR-013).

---

############################################################
# ENTITY
Membership
############################################################
**Purpose:** One person's role at one restaurant, or one org-wide role. Replaces `Employee` from v1.0 (ADR-005).

**Fields:** id, user_id, organization_id, restaurant_id (nullable), role_id, status, hire_date, created_at, updated_at

**Relationships:** Membership → User · Membership → Organization · Membership → Restaurant (nullable) · Membership → one Wallet

**Rules:** `restaurant_id IS NULL` means the role applies across every Restaurant inside `organization_id` (e.g. a chain owner). A restaurant-scoped Membership always carries both `organization_id` and `restaurant_id`. One User may hold many Memberships — including more than one inside the same Organization, as long as each is scoped to a different Restaurant. Inviting an email address that already belongs to a User attaches a new Membership to that existing User — it never creates a duplicate User row.

---

############################################################
# ENTITY
Role
############################################################
Unchanged from v1.0. Owner · Manager · Waiter · Administrator · future Accountant · future Auditor.

---

############################################################
# ENTITY
Permission
############################################################
Unchanged from v1.0. e.g. Create Restaurant, Edit Restaurant, Invite Membership, View Reports, Manage Payments, Configure Tips, Export Data, Manage Roles.

---

############################################################
# ENTITY
RolePermission
############################################################
**Purpose:** Many-to-many join so permissions stay configurable, never hardcoded — closes a gap in v1.0.

**Fields:** role_id, permission_id (composite primary key)

**Rules:** A Role's permissions are entirely defined by its `RolePermission` rows. No permission check in code may special-case a role by name.

---

############################################################
# ENTITY
Currency
############################################################
**Purpose:** Single reference table so no code path ever hardcodes a decimal-place assumption (ADR-001).

**Fields:** code (ISO 4217, primary key — e.g. `"EUR"`), exponent (e.g. `2`), name

**Rules:** Every monetary amount elsewhere in this schema is interpreted using this table's exponent for its currency. Never assume 2.

---

############################################################
# ENTITY
Wallet
############################################################
**Purpose:** A Membership's spendable/pending balance. Not a bank account — a cached projection of the Ledger (ADR-002, ADR-006).

**Fields:** id, membership_id (unique), available_balance (BIGINT, minor units), pending_balance (BIGINT, minor units), currency, status, created_at, updated_at

**Relationships:** Wallet → one Membership

**Rules:** Never written by application/business logic directly. Its only writer is the projection-updater that consumes `OutboxEvent` rows and re-derives balances from `LedgerLine`. Fully rebuildable at any time by replaying that Membership's `LedgerLine` rows from zero. The stored columns exist for read performance, not as a second source of truth. Where a person holds multiple Memberships, they have multiple Wallets — the Waiter Portal aggregates them for display; the money underneath stays separate per employer (ADR-006).

---

############################################################
# ENTITY
Payment
############################################################
**Purpose:** One attempt to capture money from a customer through the processor.

**Fields:** id, restaurant_id, processor, processor_payment_id, amount, currency, status, payment_method, idempotency_key, created_at, updated_at

**Relationships:** Payment → Restaurant · Payment → one Transaction (on success) · Payment → IdempotencyKey

**Rules:** Immutable once created, with one exception (ADR-018): `status` transitions exactly once, from `pending` to a terminal state — `succeeded` / `failed` / `canceled` / `declined` — recorded via `updated_at`. `failed` (processing error or timeout) and `declined` (card issuer rejected the charge) are distinct states, since MASTERPLAN.md's Fraud Prevention treats repeated failures as a signal. Every other field — `amount`, `restaurant_id`, `processor`, `processor_payment_id`, `currency`, `payment_method`, `idempotency_key` — never changes after creation. `idempotency_key` must reference a row in `IdempotencyKey` (ADR-004) — every Payment-creating request must supply one.

---

############################################################
# ENTITY
Transaction
############################################################
**Purpose:** The business-level record that a sale completed — an anchor other entities reference, not a store of the money breakdown.

**Fields:** id, payment_id, restaurant_id, gross_amount, currency, status, created_at

**Relationships:** Transaction → Payment · Transaction → many JournalEntry · Transaction → zero-or-one Tip

**Rules:** Never edited. Corrections happen through a new `JournalEntry` (refund / chargeback / adjustment), never by changing this row. Does **not** store `restaurant_amount`, `tip_amount`, `processing_fee`, or `platform_fee` — those exist only as `LedgerLine` rows under this Transaction's `JournalEntry`. This closes the v1.0 duplication where both Transaction and Tip separately stored a tip amount.

---

############################################################
# ENTITY
JournalEntry
############################################################
**Purpose:** One balanced financial event — the header row of a double-entry posting (ADR-002).

**Fields:** id, entry_type (`payment_captured` / `tip_allocated` / `refund_issued` / `chargeback` / `adjustment` / `payout`), transaction_id (nullable), refund_id (nullable), chargeback_id (nullable), adjustment_id (nullable), description, created_at

**Relationships:** JournalEntry → zero-or-one Transaction · JournalEntry → many LedgerLine · JournalEntry → zero-or-one Refund · JournalEntry → zero-or-one Chargeback · JournalEntry → zero-or-one Adjustment

**Rules:** Never edited or deleted. For every JournalEntry: `SUM(LedgerLine.amount WHERE direction = debit) = SUM(LedgerLine.amount WHERE direction = credit)`. This single invariant is what Smart Reconciliation checks.

**ADR-017:** `JournalEntry` — not `Refund`/`Chargeback`/`Adjustment` — owns the three nullable compensating-entry FKs, mirroring `transaction_id`. This is deliberate, not symmetric-for-its-own-sake: a `Chargeback` can produce more than one compensating `JournalEntry` over its lifetime (a provisional-loss entry immediately, then a reversal entry if the dispute is later won — ADR-016), which is a one-to-many relationship a unique FK *on* `Chargeback` could not express. `Refund` and `Adjustment` take the identical shape for consistency, even though today's flows only ever produce exactly one `JournalEntry` for either. At most one of `refund_id` / `chargeback_id` / `adjustment_id` is ever set on a given row, and whichever is set (or none, for `payment_captured` / `tip_allocated` / `payout`) must agree with `entry_type` — enforced by a database `CHECK` constraint, not just application code.

---

############################################################
# ENTITY
LedgerLine
############################################################
**Purpose:** One debit or credit inside a JournalEntry — the actual money movement (ADR-002).

**Fields:** id, journal_entry_id, account (`processor_clearing` / `restaurant_revenue_payable` / `tip_payable` / `platform_fee_revenue` / `tax_payable` / `refund_contra`), direction (`debit` / `credit`), amount (BIGINT, minor units), currency, restaurant_id (nullable), membership_id (nullable), created_at

**Relationships:** LedgerLine → JournalEntry · LedgerLine → Restaurant (nullable) · LedgerLine → Membership (nullable)

**Rules:** Never edited or deleted. `membership_id` is set only on lines crediting or debiting a specific person's Wallet — this is where tip distribution actually lives (ADR-007: one line per recipient; MVP always writes exactly one).

---

############################################################
# ENTITY
Tip
############################################################
**Purpose:** The gratuity event a customer chose, tied to one Transaction.

**Fields:** id, transaction_id, gross_tip, currency, status, created_at

**Relationships:** Tip → Transaction. Distribution is expressed entirely through `LedgerLine` rows on the Transaction's `JournalEntry` — not a field here.

**Rules:** Does not store `employee_id`, `net_tip`, or `platform_fee` — all derived from `LedgerLine` (ADR-007). This is what makes pooled/shift/percentage/role-based allocation a new code path later, not a migration: MVP's Individual strategy writes one credit `LedgerLine`; future strategies write more than one, without changing this table.

---

############################################################
# ENTITY
Refund
############################################################
**Purpose:** A customer- or staff-initiated reversal of part or all of a Transaction (ADR-008).

**Fields:** id, transaction_id, processor_refund_id, amount, currency, reason, tip_refunded (boolean), requested_by (user_id, nullable), approved_by (user_id, nullable), status, created_at

**Relationships:** Refund → Transaction · one-or-more JournalEntry reference this Refund back via `JournalEntry.refund_id` (ADR-017 — `JournalEntry` owns the FK, not this table; see JournalEntry's own entry for why).

**Rules:** Always produces a new JournalEntry whose LedgerLines reverse the original `restaurant_revenue_payable` / `tip_payable` and post to `refund_contra`. Never edits the original JournalEntry. No self-service UI required for MVP — staff may act through Stripe's dashboard, but the resulting webhook must always write this row and its compensating entry automatically. A single Transaction may have more than one Refund — each partial refund is its own row, its own compensating JournalEntry, independent of any other Refund on the same Transaction.

---

############################################################
# ENTITY
Chargeback
############################################################
**Purpose:** A card network dispute against a Transaction (ADR-008).

**Fields:** id, transaction_id, processor_dispute_id, reason, amount, currency, status, evidence_due_by, resolved_at, created_at

**Relationships:** Chargeback → Transaction · one-or-more JournalEntry reference this Chargeback back via `JournalEntry.chargeback_id` (ADR-017) — genuinely one-to-many, not just symmetric with Refund/Adjustment: the provisional-loss entry and, if the dispute is later won, the reversal entry (ADR-016) are two separate JournalEntry rows against the same Chargeback.

**Rules:** Same compensating-entry rule as Refund. Historical Chargeback data feeds fraud detection (see SYSTEM_ARCHITECTURE).

---

############################################################
# ENTITY
Adjustment
############################################################
**Purpose:** A manual correction that is neither a Refund nor a Chargeback (e.g. fixing a misallocated tip) — still never edits history.

**Fields:** id, restaurant_id (nullable), membership_id (nullable), amount, currency, reason, created_by (user_id), created_at

**Relationships:** Adjustment → Restaurant (nullable) · Adjustment → Membership (nullable) · one-or-more JournalEntry reference this Adjustment back via `JournalEntry.adjustment_id` (ADR-017).

**Rules:** `reason` and `created_by` are both required. No anonymous balance corrections, ever.

---

############################################################
# ENTITY
OutboxEvent
############################################################
**Purpose:** Guarantees every Ledger write reliably reaches its projections (ADR-003).

**Fields:** id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at (nullable), attempts

**Rules:** Inserted in the same database transaction as the JournalEntry/LedgerLine it describes. This is an operational table, not permanent financial history — rows may be purged a fixed time after `published_at` is set.

---

############################################################
# ENTITY
IdempotencyKey
############################################################
**Purpose:** Prevents duplicate financial side-effects from retries (ADR-004).

**Fields:** key, endpoint_scope, request_fingerprint, status (`in_progress` / `completed` / `failed`), response_snapshot, created_at, expires_at

**Rules:** A request reusing `key` with a matching `request_fingerprint` returns the stored `response_snapshot`. A mismatched fingerprint is rejected as a conflict, not silently processed. Operational table — rows may be purged after `expires_at`.

---

############################################################
# ENTITY
AuditLog
############################################################
**Purpose:** Permanent history of who did what.

**Fields:** id, user_id, entity, entity_id, action, metadata, ip_address, user_agent, timestamp

**Rules:** Append-only, never deleted or modified. Written by a shared interceptor applied to every mutating endpoint from Sprint 1 (ADR-010) — not a call each feature remembers to make.

---

# Future Entities

Supplier · Invoice · Withdrawal · Settlement · Notification · Promotion · Campaign · AI Insight · Forecast · Inventory · Reservation.

Intentionally excluded from MVP. Architecture should support them; implementation should wait.

**Not a gap:** RefreshToken has no table, deliberately (ADR-019) — refresh tokens are stateless signed JWTs, with revocation tracked in Redis by `jti` (one token) and by `familyId` (every token descended from one login, revoked together the moment a replay of an already-rotated-out token is detected), not a Postgres row. This is not the same as the entities above: it isn't excluded from MVP, it's simply never persisted here by design.

---

# Relationships

```
Organization
   ↓
Restaurant ← Currency
   ↓
Membership ← User
   ↓
Wallet

Restaurant
   ↓
Payment → Transaction → JournalEntry → LedgerLine → Wallet / Restaurant Balance / Analytics (projections)
                              ↑
                    Tip · Refund · Chargeback · Adjustment
                    (all post through JournalEntry / LedgerLine)
```

---

# Financial Integrity

Money never disappears. Every payment creates:

Payment
↓
Transaction
↓
Journal Entry
↓
Ledger Lines
↓
Wallet / Restaurant Balance / Analytics — projections, kept current via Outbox
↓
Audit Event

Every financial movement is explainable, and every projection can be rebuilt from `LedgerLine` alone, at any time, from zero.

---

# Naming Convention

Tables: snake_case. Columns: snake_case. Primary Keys: `id`. Foreign Keys: `entity_id`. Timestamps: `created_at`, `updated_at`, `deleted_at`.

---

# Index Strategy

Every foreign key indexed by default. In addition:
- `ledger_line.journal_entry_id`, `ledger_line.membership_id`, `ledger_line.restaurant_id`
- `wallet.membership_id` (unique)
- `outbox_event.published_at` (the poller's query)
- `idempotency_keys.key` (unique), `idempotency_keys.expires_at`
- `transaction.restaurant_id, created_at` (dashboard queries)
- `membership.user_id`, `membership.organization_id`, `membership.restaurant_id`

Indexes exist because a query pattern justifies them, never "maybe."

---

# Soft Deletes

Soft delete where the business needs recovery: `Organization`, `Restaurant`, `User`, `Membership`.

Never soft delete — permanent financial history: `Payment`, `Transaction`, `JournalEntry`, `LedgerLine`, `Tip`, `Refund`, `Chargeback`, `Adjustment`, `AuditLog`.

Purge on a retention schedule — operational, not financial history: `OutboxEvent` (after `published_at` + N days), `IdempotencyKey` (after `expires_at`).

---

# Final Principle

The database is the company's memory. The Ledger is the part of that memory that is never allowed to be wrong. Everything else in this document — Wallet, Restaurant balance, Analytics — is a view onto it, and every view can be thrown away and rebuilt. Protect the Ledger accordingly.
