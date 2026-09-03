---
title: DATABASE
version: 2.15.0
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

Twenty-two entities. Ten existed in v1.0. Ten were added directly by `ARCHITECTURE_DECISIONS.md` to close gaps the Sprint 0 review found — this is the schema catching up with already-agreed architecture, not scope creep. `MembershipInvitation` (ADR-020) is the twenty-first, added while starting Sprint 4 to close a gap between `MASTERPLAN.md`'s own user journey and the Sprint 0 schema. `AgreementAcceptance` (ADR-049) is the twenty-second, added in Sprint 14: until then a User could exist with no record of having agreed to anything.

`Organization` · `Restaurant` · `User` · `Membership` · `MembershipInvitation` · `Role` · `Permission` · `RolePermission` · `Currency` · `Wallet` · `Payment` · `Transaction` · `JournalEntry` · `LedgerLine` · `Tip` · `Refund` · `Chargeback` · `Adjustment` · `OutboxEvent` · `IdempotencyKey` · `AuditLog` · `AgreementAcceptance` · `Shift`

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

**Fields:** id, organization_id, name, legal_name, company_number, vat_number, email, phone, country, currency, default_customer_locale, timezone, address, logo_url, status, stripe_account_id, onboarding_status, card_payments_status, payouts_status, requirements_due, tip_presets, created_at, updated_at, shift_auto_close_minutes

**Shift auto-close (ADR-064).** `shift_auto_close_minutes` is the minute of the venue's own local day at which a still-open Shift closes automatically — the **safety net**, never the main path, which is the button. Per Restaurant rather than per Organization: different venues keep different hours. Not nullable, with a CHECK holding it inside `0..1439`, because a net that can be switched off is not a net and a value outside the day is the net silently absent. The default of `300` (05:00) is a placeholder so it is never missing; the number is the Founder's to set.

**Relationships:** Restaurant → Organization (parent) · Restaurant → many Membership · Restaurant → many Payment / Transaction

**Rules:** Restaurant carries `vat_number` and `company_number` because it is the tax entity, and for MVP owns its own Stripe Connect account (ADR-009, ADR-014 — Accounts v2, `dashboard: "full"`) — connected accounts are attached per location, not per Organization. `country` / `currency` mirror the connected account's fixed values; changing a restaurant's operating country means a new Stripe account, never an edit to this row. `default_customer_locale` is what the payment terminal shows before a customer touches anything — the customer has no account to store a preference in, so this is the only place it can live (ADR-013). Restaurant is never physically deleted. `currency` references `Currency.code`.

`card_payments_status` and `payouts_status` mirror Stripe's own v2 capability-status strings (`configuration.merchant.capabilities.card_payments.status` and `configuration.merchant.capabilities.stripe_balance.payouts.status` respectively — confirmed against a real API response, ADR-009's revision) — not booleans, and deliberately not a Postgres enum either, since this vocabulary belongs to Stripe and can grow without a migration on our side. `requirements_due` stores Stripe's real `requirements.entries[]` array as-is (JSON) — a list of requirement objects, not requirement-name strings.

`tip_presets` (Sprint 6, ADR-022): an array of integer percentages (e.g. `[10, 15, 20]`) shown to the customer at Tip Selection (UX_MAP.md) — display configuration only, never a validation rule on `Payment.tip_amount`, which is a plain minor-units amount the terminal computes from whichever preset or Custom value the customer picks. Defaults to `[10, 15, 20]` (`API_Contract.md`'s own example), editable per Restaurant via `PATCH /restaurants/{id}/settings/tips`.

---

############################################################
# ENTITY
User
############################################################
**Purpose:** Authentication identity.

**Fields:** id, email, display_name, password_hash, email_verified, two_factor_enabled, locale, last_login, status, created_at, updated_at, stripe_account_id, stripe_onboarding_status, stripe_transfers_status, stripe_payouts_status, stripe_requirements_due, stripe_account_created_at

**Stripe recipient account (ADR-061, Model B).** One person, one connected account, attached here and never to a Membership: a waiter completes KYC once and carries it between venues, and a second Membership references the same account through `user_id` without creating anything. `stripe_account_id` is unique and nullable — only a User invited as staff ever gets one — and a database CHECK refuses the empty string, so NULL is the only way to say "no account". This is a **recipient** account (v2, `configuration.recipient`, `dashboard: "none"`): it receives transfers and never takes card payments, and it must not be handed to code written for `restaurant.stripe_account_id`, which is a merchant account. `stripe_onboarding_status` reuses the `onboarding_status` enum and reads `complete` when `stripe_transfers` is active — the one status that decides whether this person may be selected as a tip recipient at all (ADR-061 §3). `stripe_transfers_status` and `stripe_payouts_status` are kept separately because they answer different questions — may money reach this account, and may it leave to a bank — and a person can be a valid recipient while payouts still wait on a bank account. All of it is derived from the live account on refresh, never parsed from a webhook payload, the same rule Restaurant follows (ADR-009). Measured against the live API on 2026-09-02 for an individual in Lithuania: twelve requirement entries at creation — name, date of birth, address, bank account, Terms attestation, `business_url` — and **no identity document**.

**Relationships:** User → many Membership (across Organizations and Restaurants)

**Rules:** Email unique. Passwords never stored in plaintext or logged. A User with zero Memberships is valid (mid-invitation). `locale` is the language this person sees the Restaurant Portal or Waiter Portal in — English or Lithuanian at MVP (ADR-013). `display_name` (ADR-033, Sprint 13): required, set at registration or invitation-accept — the name the terminal's own staff-selection picker shows; before this, `User` had no name field at all. Required rather than nullable because production had zero real `User` rows at the moment this field was added (confirmed directly, not assumed) — nothing to backfill.

---

############################################################
# ENTITY
Membership
############################################################
**Purpose:** One person's role at one restaurant, or one org-wide role. Replaces `Employee` from v1.0 (ADR-005).

**Fields:** id, user_id, organization_id, restaurant_id (nullable), role_id, status, hire_date, created_at, updated_at

**Relationships:** Membership → User · Membership → Organization · Membership → Restaurant (nullable) · Membership → one Wallet

**Rules:** `restaurant_id IS NULL` means the role applies across every Restaurant inside `organization_id` (e.g. a chain owner). A restaurant-scoped Membership always carries both `organization_id` and `restaurant_id`. One User may hold many Memberships — including more than one inside the same Organization, as long as each is scoped to a different Restaurant. Inviting an email address that already belongs to a User attaches a new Membership to that existing User at acceptance time (see MembershipInvitation) — it never creates a duplicate User row.

---

############################################################
# ENTITY
MembershipInvitation
############################################################
**Purpose:** A pending invitation to join an Organization (org-wide) or a specific Restaurant, before the invitee has a `User` row at all. Exists so `User.password_hash` never has to represent "invited, no password yet" (ADR-020) — a real `Membership` is only ever created once an invitation is accepted, never before.

**Fields:** id, email, organization_id, restaurant_id (nullable), role_id, invited_by (user_id), token_hash, expires_at, accepted_at (nullable), created_at, updated_at

**Relationships:** MembershipInvitation → Organization · MembershipInvitation → Restaurant (nullable) · MembershipInvitation → Role · MembershipInvitation → User (`invited_by` — who sent it)

**Rules:** `restaurant_id` follows the same nullable-means-org-wide convention as `Membership` (ADR-005) — an invitation is for one Restaurant or for the whole Organization, mirroring exactly what the resulting Membership will be. `token_hash` is a hash of the invitation token, never the raw token (ADR-020, same principle as `User.password_hash`) — the raw token exists exactly once, returned to the inviter at creation time, never stored anywhere in a comparable-in-plaintext form. Verifying a presented token means looking up candidate rows by `email` (a known, non-secret field) and hash-comparing the token against each candidate's `token_hash` — the same shape as verifying a password, never a lookup keyed on the secret itself. `invited_by` is kept as its own field rather than derived from `AuditLog`, since a pending-invitations screen is a direct, frequent read, not an audit reconstruction. Accepting an invitation creates `User` (only if no `User` already exists for that `email`) and `Membership` together, atomically, and sets `accepted_at`; an already-accepted or expired (`expires_at` passed) invitation can no longer be accepted. Not soft-deleted (see Soft Deletes) — an expired or accepted invitation is operational history, not a financial or identity fact worth recovering.

---

############################################################
# ENTITY
Role
############################################################
Owner · Manager · Waiter · Administrator · future Accountant · future Auditor.

**`platform_only` (boolean, default false) — added Sprint 14, ADR-044.** True means the Role is ours to grant and may never be offered to a Restaurant. `Administrator` is seeded true: it holds every Permission and its description has always said "platform-level", but until this column existed nothing enforced that — `POST /memberships` validated only that the `role_id` *existed*, so any Owner could grant it.

**A constraint on the data, not on the interface.** Filtering it out of a dropdown while the endpoint still accepted it would be the worse outcome: the screen would look correct and a direct API call would still work. Every write path that takes a `role_id` refuses a `platform_only` Role — invite, update, and invitation-accept — and `GET /roles` omits them from the list.

**`name` still does two jobs**, and that is recorded rather than fixed: it is the stable upsert key (`seed.ts` upserts on it) *and* the text a human reads in a Role picker. They coincide only while the product is English. `IMPLEMENTATION_PLAN.md` carries the item, triggered by Lithuanian arriving (ADR-040).

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

**Rules:** Never written by application/business logic directly. Its only writer is the projection-updater that consumes `OutboxEvent` rows and re-derives balances from `LedgerLine` — a full recompute (`SUM` over that Membership's own `LedgerLine` rows) on every dispatch, not an incremental delta (ADR-024) — which is also why it's fully rebuildable at any time by replaying that Membership's `LedgerLine` rows from zero: rebuilding isn't a separate code path, it's the same recompute called after the row is gone. The stored columns exist for read performance, not as a second source of truth. Where a person holds multiple Memberships, they have multiple Wallets — the Waiter Portal aggregates them for display; the money underneath stays separate per employer (ADR-006).

`pending_balance` (ADR-024): always `0` for MVP — not because nothing is conceptually pending, but because `Withdrawal` doesn't exist yet (a Future entity, no working implementation). With no way to cash anything out of a Wallet at all, "available" and "pending" would just be two labels on the identical, equally-uncashable balance — a display split with no monetary meaning until `Withdrawal` ships and gives the distinction something real to distinguish. The field stays in the schema for that.

---

############################################################
# ENTITY
Payment
############################################################
**Purpose:** One attempt to capture money from a customer through the processor.

**Fields:** id, restaurant_id, processor, processor_payment_id, amount, tip_amount, waiter_membership_id (nullable), currency, status, payment_method, idempotency_key, created_at, updated_at

**Relationships:** Payment → Restaurant · Payment → one Transaction (on success) · Payment → IdempotencyKey · Payment → Membership (`waiter_membership_id`, nullable — the explicitly-selected tip recipient, ADR-033; not necessarily the caller — see Tip fields below)

**Rules:** Immutable once created, with one exception (ADR-018): `status` transitions exactly once, from `pending` to a terminal state — `succeeded` / `failed` / `canceled` / `declined` — recorded via `updated_at`. `failed` (processing error or timeout) and `declined` (card issuer rejected the charge) are distinct states, since MASTERPLAN.md's Fraud Prevention treats repeated failures as a signal. Every other field — `amount`, `tip_amount`, `waiter_membership_id`, `restaurant_id`, `processor`, `processor_payment_id`, `currency`, `payment_method`, `idempotency_key` — never changes after creation. `idempotency_key` must reference a row in `IdempotencyKey` (ADR-004) — every Payment-creating request must supply one.

**Tip fields (ADR-022, revised ADR-033):** `amount` is the full amount charged to the card — bill and tip combined, matching the single "Card Payment" step in UX_MAP.md's Payment Flow — never split into two client-facing fields. `tip_amount` is the caller-submitted tip portion of it (`tip_amount <= amount`, validated at request time); `amount - tip_amount` is the bill-only amount every platform-fee computation must use (ADR-021: fee excludes tips). `waiter_membership_id` (ADR-033, Sprint 13) is an explicit terminal selection — "who actually served this table" — validated as a real, `ACTIVE`, reachable Membership at the Restaurant, with no Role restriction (any staff member, not only one holding a Waiter Role). No longer derived from the authenticated caller (ADR-022's original mechanism) — the caller and the tip recipient are two independently tracked facts now (`AuditLog` records both, ADR-033 Decision 4). Required when `tip_amount > 0` (enforced at the request boundary, before Stripe is ever called); `null` when `tip_amount` is 0 — nobody to attribute.

---

############################################################
# ENTITY
Transaction
############################################################
**Purpose:** The business-level record that a sale completed — an anchor other entities reference, not a store of the money breakdown.

**Fields:** id, payment_id, restaurant_id, gross_amount, currency, status, created_at

**Relationships:** Transaction → Payment · Transaction → many JournalEntry · Transaction → zero-or-one Tip

**Rules:** Never edited. Corrections happen through a new `JournalEntry` (refund / chargeback / adjustment), never by changing this row. Does **not** store `restaurant_amount`, `tip_amount`, `processing_fee`, or `platform_fee` — those exist only as `LedgerLine` rows under this Transaction's `JournalEntry` rows (plural: one Transaction can carry several over its life — `PAYMENT_CAPTURED` plus any later `TIP_ALLOCATED`/`REFUND_ISSUED`/`CHARGEBACK`). This closes the v1.0 duplication where both Transaction and Tip separately stored a tip amount. A read-time breakdown sums `CREDIT` minus `DEBIT` per account across **all** of them, not just `PAYMENT_CAPTURED` — Sprint 8, ADR-025 — so a refunded or disputed Transaction shows its current net effect, not a snapshot frozen at capture.

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

**Fields:** id, journal_entry_id, account (`processor_clearing` / `restaurant_revenue_payable` / `tip_payable` / `platform_fee_revenue` / `tax_payable` / `refund_contra`), direction (`debit` / `credit`), amount (BIGINT, minor units), currency, restaurant_id (nullable), membership_id (nullable), shift_id (nullable), created_at

**Two labels, and neither derives the other (ADR-064).** `created_at` is the **calendar instant** — unchanged, because accounting and tax are calendar-bound. `shift_id` is the **operational** label: which of the venue's own working days this money belongs to. A payment at 01:30 on a shift nobody has closed carries that shift *and* today's calendar timestamp, both at once. On LedgerLine rather than Transaction because this is where every figure is already aggregated (ADR-024, ADR-025, ADR-026), so a shift-scoped total is the same query with a different filter rather than a second way of counting. Nullable: rows written before ADR-064 have no shift, and a line with no `restaurant_id` has none to belong to.

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

**Rules:** Always produces a new JournalEntry whose LedgerLines reverse `restaurant_revenue_payable` and `platform_fee_revenue`, each proportionally over the **bill** (gross − tip) — **never `tip_payable`** (ADR-062: a refund returns the bill; the tip stays with the waiter, which is industry practice). `tax_payable` joins the reversal the day it has a writer. `refund_contra` is credited with the full amount Stripe actually returned. **A refund larger than the bill is refused before any row is written** (`REFUND_EXCEEDS_BILL`): the excess is the tip physically returned to the guest, and the rule gives it no balanced side, so the handler leaves the event for retry and alerting rather than booking a side nobody chose. `tip_refunded` is written `false` for every refund; rows from ADR-023's era carry `true` and are history. A Transaction is `refunded` when the bill is fully refunded, `partially_refunded` below that. **Chargebacks are not this rule** — a chargeback still reverses all three accounts proportionally over the gross (ADR-023), because the bank returns the whole charge and that question is open (`THREAT_MODEL.md`).

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

**Rules:** A request reusing `key` with a matching `request_fingerprint` returns the stored `response_snapshot`. A mismatched fingerprint is rejected as a conflict, not silently processed. Operational table — rows may be purged after `expires_at`. Two distinct writers share this same table (Sprint 5): client HTTP requests key by the caller-supplied `Idempotency-Key` header, fingerprint-checked as above; incoming Stripe webhooks key by the provider's own event id instead (API_Contract.md, Idempotency) — `request_fingerprint` there is set to the event's `type`, since a fingerprint-mismatch conflict can't meaningfully happen for an id Stripe itself guarantees is unique.

---

############################################################
# ENTITY
AuditLog
############################################################
**Purpose:** Permanent history of who did what.

**Fields:** id, user_id, entity, entity_id, action, metadata, ip_address, user_agent, timestamp

**Rules:** Append-only, never deleted or modified. Written by a shared interceptor applied to every mutating endpoint from Sprint 1 (ADR-010) — not a call each feature remembers to make.

---

# ENTITY
AgreementAcceptance
############################################################
**Purpose:** What a specific party agreed to, which revision of it, and when. Added by ADR-049 (Sprint 14) after the Stripe research established that we owe both our own terms of service and our own privacy policy, and that a published document nobody is recorded as having read proves nothing about any particular person.

**Fields:** id, agreement, version, user_id, restaurant_id, accepted_at, ip_address, user_agent

**Rules — two subjects, exactly one per row, and this is the substantive part of the design.** Platform terms are accepted by a **person** (`user_id`); Stripe's connected-account agreement is accepted by a **business** (`restaurant_id`). One table serves both, and precisely one subject column is populated.

The reason is a waiter: they sign up as a person, work a shift, and never touch Stripe. Collapsing both agreements onto `User` would record them as having accepted a payment processor's terms they have no relationship with — and it would be wrong in the other direction too, since the Stripe account holder is the legal entity, and a Restaurant can outlive the individual who created it.

**Two `CHECK` constraints make that a rule rather than a convention**, both applied in the migration rather than expressed in Prisma:

- `agreement_acceptance_subject_matches_type` — platform terms require a user and forbid a restaurant; the Stripe agreement requires the reverse.
- `agreement_acceptance_version_not_blank` — `NOT NULL` is satisfied by `"   "`, and such a row would claim someone agreed to a revision it cannot name. The empty string is a present value, not an absent one.

**Written in the same transaction as the `User` it belongs to** (`AuthService.register`). A User existing without one would be a person using the platform with no record of having agreed to anything, which is the gap this closes.

**The submitted version is checked against the server's own and a mismatch is refused** (409 `TERMS_VERSION_MISMATCH`), never silently corrected — correcting it would record agreement to a document the person was never shown.

**Not soft-deleted, and not on the erasure path** (ADR-052): a redaction clears the person, and this row is the evidence that the person agreed to something. Its `ip_address` and `user_agent` are personal data that emptying the `User` does not reach — an open decision recorded in `PERSONAL_DATA_MAP.md` §6, and the reason the erasure script reports every run as partial until it is made.

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
- `membership_invitation.email` (the acceptance lookup — candidate rows by email, then hash-compare the token, ADR-020)

Indexes exist because a query pattern justifies them, never "maybe."

---

# Soft Deletes

Soft delete where the business needs recovery: `Organization`, `Restaurant`, `User`, `Membership`.

Never soft delete — permanent financial history: `Payment`, `Transaction`, `JournalEntry`, `LedgerLine`, `Tip`, `Refund`, `Chargeback`, `Adjustment`, `AuditLog`.

Purge on a retention schedule — operational, not financial history: `OutboxEvent` (after `published_at` + N days), `IdempotencyKey` (after `expires_at`), `MembershipInvitation` (after `expires_at`, once accepted or expired).

## One recorded exception to the rule above, and the larger part of it is what was NOT deleted

**2026-08-26.** Two `Payment` rows were hard-deleted from production, along with the `Organization`, `Restaurant`, two `Membership` rows, one `MembershipInvitation` and ten `IdempotencyKey` rows created during Sprint 13's live verification. Recorded here, next to the rule it departs from, so a later reader does not find the rule and the action and have to reconcile them from git archaeology.

**Why the exception is legitimate.** The rule protects records of *real money movement* — that is what makes financial history immutable and worth defending. These two payments describe nothing that happened: the `PaymentIntent`s were created but never confirmed with a card, so they never reached `succeeded`, never produced a `Transaction`, and never wrote a single `JournalEntry` or `LedgerLine`. All money-bearing tables were verified empty before and after (`transaction`, `journal_entry`, `ledger_line`, `tip`, `refund`, `chargeback`, `wallet` — zero rows throughout). Nothing was reversed, because nothing had happened.

**The decisive argument was about backups, not tidiness.** These rows would be captured by PITR and by every volume snapshot, and a future reader restoring a backup would find payments with real amounts, real Stripe PaymentIntent ids and a real connected account — indistinguishable from genuine ones without reconstructing this session's history. Synthetic financial records that survive into backups are worse than clutter; they are a trap for whoever reads them next.

**What was deliberately NOT deleted, which matters more than what was — read this before "finishing the cleanup".**

`User` rows and `AuditLog` were left completely untouched, and re-deleting them later would be a mistake, not a continuation:

- **`AuditLog` is append-only** by this document's own rule, and by its purpose (`THREAT_MODEL.md` Closed Threat #14). It contains genuine external security telemetry — a Leakix vulnerability scanner probing production for exposed GraphQL endpoints on 2026-08-20, plus real crawler and Stripe webhook traffic. Those are records of things that genuinely happened to a live system, not test residue.
- **`audit_log.user_id` → `user` is `ON DELETE SET NULL`.** This is the sharp edge: deleting the test users would not fail and would not remove any audit row — it would **silently blank the actor on eighteen of them**, leaving records that say *something was done* with *who did it* erased. That is corruption wearing the appearance of integrity, and it is strictly worse than an honest deletion, because nothing about the result looks wrong.
- The justification used for the payments does not transfer. Those accounts *were* really created and really authenticated; the `AuditLog` is the record of it. And they are not confusable with real data the way a phantom payment is: every address is `@example.com`, a domain reserved by RFC 2606 that can never belong to a real person.

**Root cause, not to be mistaken for carelessness:** test data reaches production because there is nowhere else for a live verification to run. The project has exactly one Railway environment, so anything that is not a developer's laptop *is* production (ADR-035, staging deliberately deferred). Until staging exists, every live verification leaves a trace like this, and cleaning it up by hand each time is the cost of that deferral — not a process failure to fix by being more careful.

---

# Local Development: Resetting to a Clean Seed

`pnpm db:reset` (root) or `pnpm run db:reset` (`apps/backend`) drops the local database, reapplies every migration from scratch, and runs `prisma/seed.ts` — a thin wrapper around Prisma's own `prisma migrate reset --force`. The seed script itself is idempotent (`upsert`, not `create`): it repopulates only reference data — `Currency` (ISO 4217, ADR-001) and the RBAC seed (`Role` / `Permission` / `RolePermission`) — never anything transactional.

This exists because manual verification during development (live HTTP + SQL checks, per this document's own Definition of Done standard) leaves behind test Organizations, Restaurants, Payments, and Ledger entries that accumulate silently across a session and get rediscovered, confusingly, in the next one. Prisma's reset primitive was chosen over a hand-written cleanup script deliberately: an ad hoc `DELETE` script has to get every foreign-key ordering right by hand (`ledger_line` before `journal_entry`, `refund` before `transaction`, and so on) and is one missed dependency away from a `CHECK` constraint violation — dropping and replaying the schema sidesteps that entire class of mistake.

---

# Final Principle

The database is the company's memory. The Ledger is the part of that memory that is never allowed to be wrong. Everything else in this document — Wallet, Restaurant balance, Analytics — is a view onto it, and every view can be thrown away and rebuilt. Protect the Ledger accordingly.


############################################################
# ENTITY
Shift
############################################################
**Purpose:** A restaurant's own working day, which is **not** the calendar day (ADR-064). The venue closes its day with a Z-report — usually before midnight, regularly after it — and a payment at 01:30 on a shift nobody has closed belongs to that shift.

**Fields:** id, restaurant_id, opened_at, closed_at, close_reason (`button` / `scheduled`), closed_by (nullable), business_date, created_at, updated_at

**Relationships:** Shift → Restaurant (parent) · Shift → many LedgerLine · Shift → User (`closed_by`, nullable)

**Rules.** `closed_at IS NULL` means open, and **exactly one Shift per Restaurant may be open at a time** — enforced by a partial unique index, not by the service, because `resolveOpenShift` reads-then-creates and two concurrent first payments would otherwise both insert.

**Two ways to close, and they are not equal.** `close_reason = 'button'` is a person deciding; `'scheduled'` is the safety net firing because nobody did. The button wins **by construction**: once `closed_at` is set the shift is not open, and the sweep only selects open shifts — no rule anywhere compares the two times. A CHECK keeps `closed_at` and `close_reason` consistent: both set, or both null.

`closed_by` is NULL for a scheduled close — an actor that is not a person is absent rather than invented — and is set to NULL by the FK if that User is later deleted, so a historical row never blocks a deletion.

`business_date` is the venue's local calendar date **at `opened_at`**: the name a human gives this working day ("the shift of 2 September"), not a window. A shift running past midnight keeps it while its operations carry their own real timestamps.

**Shifts open lazily**, on the first operation at a venue with none, so no operation is ever shift-less.
