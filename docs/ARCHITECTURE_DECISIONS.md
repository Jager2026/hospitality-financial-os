---
title: ARCHITECTURE_DECISIONS
version: 1.1.0
status: Active — eighteen ADRs, all Accepted
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ARCHITECTURE_DECISIONS.md

> "When someone asks in six months why we built it this way, the answer should already be written down."

Purpose: record every architecture-level decision made while resolving the Sprint 0 documentation review, together with the reasoning behind each one. MASTERPLAN.md remains the single source of truth for product scope and philosophy. This document is the single source of truth for *how* the architecture implements that scope. Where DATABASE, SYSTEM_ARCHITECTURE, API, or IMPLEMENTATION_PLAN need to describe one of these decisions, they should reference the relevant ADR rather than restate it.

Status values:
- **Accepted** — settled, ready to design and implement against.
- **Proposed** — the technical shape is described, but a founder or business decision is still required before it can be marked Accepted.

---

## ADR-001 — Money Representation
**Status:** Accepted

**Context:** Financial calculations must never use floating-point arithmetic. The platform is expected to operate in more than one currency over time, and not all currencies use two decimal places — ISO 4217 defines exponent 0 for currencies like JPY, and exponent 3 for currencies like BHD or KWD.

**Decision:** All monetary amounts are stored as `BIGINT` in the currency's minor unit. The exponent used to convert to and from minor units is looked up per currency from a static reference table keyed by ISO 4217 code — never hardcoded as "divide by 100" anywhere in application code. Any calculation that splits an amount across multiple recipients (tip shares, fee shares) uses one documented, deterministic method — the largest remainder method — so the sum of the parts always equals the original whole exactly.

**Consequences:** Requires a `Currency` reference table before Sprint 1. All amount-splitting logic must go through one shared function; it may never be reimplemented per feature.

---

## ADR-002 — Ledger as Source of Truth (Double-Entry, Not Full Event Sourcing)
**Status:** Accepted

**Context:** Wallet and Transaction were previously treated as sources of truth with no unifying ledger. A later proposal called for an "event-driven ledger," which conflates two distinct patterns: event sourcing (state is derived by replaying an event log) and double-entry bookkeeping (state is a directly queryable table of balanced entries). For a small team building a reconciliation-first product, these are not equivalent in cost or benefit.

**Decision:** The Ledger is a plain, immutable, directly queryable double-entry table (`journal_entry` / `ledger_line`) — not an event-sourced aggregate that must be replayed to compute current state. Every financial action writes at least two balanced lines across a fixed chart of accounts, minimally:
- Processor Clearing (asset)
- Restaurant Revenue Payable (liability)
- Tip Payable (liability)
- Platform Fee Revenue (income)
- Tax Payable (liability, where applicable)
- Refund Contra (contra-revenue)

Wallet balance, Restaurant balance, and Analytics figures are **projections** computed from the Ledger. None of them is ever edited directly.

**Consequences:** Reconciliation becomes a SQL query (sum of debits = sum of credits per account), not a manual or batch process — this directly serves the product's own "Smart Reconciliation" value proposition. Any projection can be rebuilt at any time by re-aggregating Ledger rows for its account. This is materially simpler to operate, test, and audit than full event sourcing, at the cost of finalizing the chart of accounts above before Sprint 1.

---

## ADR-003 — Event Delivery via Transactional Outbox
**Status:** Accepted

**Context:** Domain events (PaymentCompleted, TipCreated, WalletUpdated) were referenced as architecturally central with no stated delivery mechanism. Without one, a crash between "Ledger write succeeds" and "projections update" can silently desynchronize Wallet and Analytics from the Ledger — the exact failure mode a reconciliation-first product cannot afford.

**Decision:** Use the Transactional Outbox pattern. Every transaction that writes to the Ledger also inserts a row into an `outbox_event` table (aggregate type, aggregate id, event type, payload, nullable `published_at`, attempt count) in the *same* database transaction. A separate, lightweight polling worker reads unpublished rows and applies them to projections, retrying on failure. A full CDC-based relay (e.g., Debezium) is explicitly out of scope for MVP; a simple polling publisher is sufficient at this scale and consistent with "simple before clever."

**Consequences:** Guarantees no Ledger write is ever lost from projections, including across a crash or restart. Adds one table and one background worker; no message broker is required for MVP.

---

## ADR-004 — Idempotency as a Stateful Record
**Status:** Accepted

**Context:** The API contract requires an `Idempotency-Key` header on financial endpoints. A bare unique constraint on `Payment` does not handle two real cases: the same key resubmitted with a *different* request body (must be rejected, not silently processed), and a legitimate retry of an *identical* request (must return the original response, not error).

**Decision:** Introduce an `idempotency_keys` table: key, endpoint scope, request fingerprint hash, status (`in_progress` / `completed` / `failed`), stored response snapshot, `expires_at`. Incoming webhooks are deduplicated the same way, keyed by the provider's own event id.

**Consequences:** Slightly more schema than a single unique column, but correctly handles network timeouts, client retries, and duplicate webhook delivery — all of which occur in normal production operation, not just as edge cases.

---

## ADR-005 — Restaurant Hierarchy: Organization → Restaurant → Membership → User
**Status:** Accepted

**Context:** A flat `Restaurant` entity combined with a one-to-one `User`↔`Employee` relationship cannot represent a multi-location business, nor a person holding a role at more than one restaurant — both of which the product's own UX and business documents assume exist.

**Decision:** Introduce `Organization` as the entity that owns one or more `Restaurant` records. Replace `Employee` with `Membership` (`user_id`, `restaurant_id` nullable, `role_id`). A `NULL restaurant_id` represents an organization-wide role — for example, an owner overseeing every location in a chain — rather than requiring a separate Membership row per restaurant for that person.

**Consequences:** A single `User` can hold different roles at different restaurants, or one org-wide role, without duplicated identity records. Adding restaurant #13 to a chain never requires remembering to also re-grant the owner's access.

---

## ADR-006 — Wallet Is Scoped to Membership, Not to User
**Status:** Accepted

**Context:** If a person holds Memberships at more than one restaurant, the tips and wages from each are typically owed by a different legal employer — a different `Restaurant`, potentially a different Stripe Connect account and tax jurisdiction. A single balance merging both would commingle money owed by two different employers.

**Decision:** `Wallet` belongs to a `Membership` — one wallet per person-per-restaurant relationship — not directly to `User`. Where a person holds multiple Memberships, the Waiter Portal presentation layer aggregates multiple wallets into one combined view; the underlying ledgers, balances, and payouts remain separate per Membership.

**Consequences:** Slightly more aggregation logic in the UI layer. Correctly avoids mixing money owed by two different employers under one balance, which matters for tax withholding and payout routing.

---

## ADR-007 — Tip Allocation: Individual in MVP, Schema Ready for Splits
**Status:** Accepted

**Context:** Tip pooling, shift-based, and percentage-based distribution are common in this industry and are explicitly part of the long-term vision. The original data model expressed a tip as exactly one transaction → one waiter → one tip, with no path to change this without a migration.

**Decision:** A `Tip` is a single gross gratuity event tied to a `Transaction`. Its distribution is expressed as one or more Ledger credit lines to Membership wallets (per ADR-002 / ADR-006), never as a hardcoded `Tip.employee_id` foreign key. MVP writes exactly one credit line per tip (Individual strategy). Pool, Shift, Percentage, and Role-based strategies are designed for but **not implemented** until a real restaurant needs one.

**Consequences:** Adding a new allocation strategy later means writing multiple Ledger lines from one Tip event — a new code path, not a schema migration.

---

## ADR-008 — Refunds and Chargebacks Are Real in MVP
**Status:** Accepted

**Context:** Refunds and chargebacks will occur from the first live transactions — unlike tip pooling, this is not a hypothetical future need. A schema-only placeholder without working webhook handling leaves the Ledger silently wrong the first time a customer disputes a charge.

**Decision:** `Refund`, `Chargeback`, and `Adjustment` are modeled entities, and Stripe's refund and dispute webhooks are handled starting in Sprint 5: each writes a compensating Ledger entry — the original entry is never edited or deleted. No self-service refund UI is required for MVP; staff may initiate a refund manually through Stripe's own dashboard, but the resulting webhook must always produce a correct, automatic Ledger correction.

**Consequences:** Modestly more Sprint 5 scope than payments alone. Avoids a broken ledger and manual balance-fixing during the pilot phase, when trust with the first restaurants is the thing being tested.

---

## ADR-009 — Stripe Connect Account Fields
**Status:** Accepted

**Context:** No money can move until each restaurant's connected account and onboarding state are tracked. Stripe's connected-account country and default currency are fixed at creation and cannot be changed afterward.

**Decision:** `Restaurant` stores `stripe_account_id`, `onboarding_status`, `charges_enabled`, `payouts_enabled`, and `requirements_due`, mirroring Stripe's own Account object. For MVP, the connected account is attached at the Restaurant level — each location has its own payout account — rather than at Organization level, since Restaurant already represents one legal and tax entity (it carries `legal_name`, `vat_number`, `company_number`). Centralized org-level payouts for chains are a distinct, later feature, not a redesign of this decision.

**Consequences:** The onboarding flow (Sprint 3) must explicitly handle "restaurant created, Stripe onboarding incomplete" as a real state, not treat restaurant creation and payment-readiness as the same event.

---

## ADR-010 — Audit Logging and Rate Limiting Belong to Foundation
**Status:** Accepted

**Context:** Both were previously scheduled inside a standalone Sprint 11 "Security" sprint, after nine sprints of unaudited registration, authentication, and payment activity.

**Decision:** The Audit Log write path is a shared interceptor applied to all mutating endpoints — not a utility each feature must remember to call — and baseline rate limiting is a global throttling module, tuned per endpoint later against the limits already specified in API_Contract. Both are built in Sprint 1, before Authentication.

**Consequences:** Sprint 11 becomes a hardening and penetration-testing pass on controls that already exist, not their first implementation.

---

## ADR-011 — One Canonical AI / Engineering Rules Document
**Status:** Accepted

**Context:** CTO Operating Manual, CLAUDE_RULES, Masterplan's AI-related sections, and AI_WORKFLOW currently restate the same behavioral guidance in four places — the mechanism by which the MVP-scope contradiction between documents was able to occur in the first place.

**Decision:** `CLAUDE_RULES.md` — already classified Critical / Highest priority — becomes the single canonical source for AI and engineering behavior. CTO Operating Manual is retired. Masterplan's AI-related sections and AI_WORKFLOW are trimmed to a short reference pointing to `CLAUDE_RULES.md` rather than restating its content.

**Consequences:** Future rule changes are made in exactly one place.

---

## ADR-012 — Launch Market: Lithuania
**Status:** Accepted

**Context:** The architecture review was thorough on technical decisions but did not name a target launch country or currency. This was not an oversight to fix technically — it was a business decision that happened to gate one technical step: a Stripe connected account requires a country at creation (ADR-009).

**Decision:** Lithuania, EUR. Verified against Stripe's own current country list — Lithuania is fully supported for Stripe Connect account creation, not a restricted "Preview" market. EUR is already the default assumption throughout `DATABASE.md`'s Currency table and every worked example in `MASTERPLAN.md`.

**Consequence worth carrying into Sprint 3 (Tax Information):** as of 1 January 2026, Lithuania replaced its old 9% reduced VAT rate with a new 12% rate that applies specifically to restaurant and catering services — most restaurant bills fall here, not under the 21% standard rate. Alcoholic beverages within the same bill may or may not qualify for the reduced rate; confirm with a Lithuanian accountant before encoding this into Settings, rather than assuming either way.

**Still open, not blocking:** interface language. Country-specific logic remains isolated per this document's own architecture principle, so this decision doesn't touch DATABASE, API, SYSTEM_ARCHITECTURE, or UX_MAP — it lives here and feeds Sprint 3's configuration, nothing else.

---

## ADR-013 — Interface Language: English + Lithuanian, User-Switchable
**Status:** Accepted

**Context:** `UX_MAP.md` v1.0 already listed "Language" as a Settings/Profile item in both the Restaurant Portal and Waiter Portal, without ever specifying which languages, where the preference lives, or how the customer-facing terminal — which has no user account, by design (ADR-005 predates this, but the zero-registration customer experience was always MASTERPLAN's own rule) — selects one.

**Decision:** English and Lithuanian for MVP, switchable per user. `User` gains a `locale` field — staff pick their own, stored against their account. `Restaurant` gains a `default_customer_locale` field, since the customer has no account to store a preference in; the terminal defaults to it and offers a lightweight, non-persisted toggle for that single transaction only, never saved anywhere. Stripe's own hosted card element and Checkout both accept a `locale` parameter, and `lt` is natively supported by Stripe today (confirmed against Stripe's current documentation) — the same toggle value passes straight through, so the card-entry portion of the flow localizes with no extra translation work. Frontend implementation uses a proper i18n library (e.g. next-intl) with message catalogs from day one, rather than ad hoc string switches — a third language later becomes a translation file, not a refactor.

**Consequences:** `User.locale` (Sprint 2), `Restaurant.default_customer_locale` (Sprint 3), the terminal toggle plus passing `locale` through to Stripe (Sprint 5). Every user-facing string must route through the i18n layer from the start — a discipline requirement for whoever builds each screen, not a schema one.

---

## ADR-014 — Stripe Connect Account Type: Express
**Status:** Accepted

**Context:** Restaurant Onboarding (ADR-009) established that each Restaurant owns its own Stripe Connect account, but never specified which of Stripe's account types — Standard, Express, or Custom — to use. Custom means building the entire onboarding UI ourselves; Standard gives the restaurant full access to their own Stripe Dashboard; Express sits between the two.

**Decision:** Express. Stripe hosts the KYC and bank-account collection flow directly through Account Links — none of that ever reaches our servers, keeping onboarding-related compliance scope on Stripe rather than us. The Restaurant Portal keeps its own branding for everything else; only the onboarding step itself is Stripe-hosted.

**Consequences:** Faster to build than Custom, more platform control over branding than Standard. If a restaurant ever needs direct access to Stripe's own dashboard — to issue a manual refund per ADR-008, for instance — Express supports that too.

---

## ADR-015 — Receipt Timing: Client-Side Confirmation, Asynchronous Ledger
**Status:** Accepted

**Context:** Walking through the Payment + Tip sequence diagram surfaced a question no prior document had answered: does the customer's receipt wait for the Ledger write, Outbox publish, and Wallet projection to complete, or does it show immediately once Stripe confirms the card?

**Decision:** The receipt shows immediately, driven by Stripe.js's synchronous client-side confirmation. The Ledger write, Tip allocation, and every downstream projection are triggered separately by Stripe's `payment_intent.succeeded` webhook, which is asynchronous by nature and can arrive a second or more after the customer already sees success. Wallet, Restaurant balance, and Analytics briefly lag the true Ledger state by however long the webhook and Outbox Worker take to run.

**Consequences:** This is the same eventual-consistency behavior ADR-002 and ADR-006 already designed Wallet to tolerate — it is the intended shape, not a defect. A waiter watching their Wallet live may see a tip appear a second or two after the customer has already left, and that is correct.

---

## ADR-016 — Chargeback Handling: Provisional Loss, No Held-Funds Account
**Status:** Accepted

**Context:** Walking through the Refund/Chargeback sequence diagram surfaced a real gap: the six-account chart of accounts (ADR-002) has no account representing money that is disputed but not yet resolved — only accounts for money that has settled one way or the other.

**Decision:** For MVP, a `charge.dispute.created` webhook is treated as a provisional loss: it writes a compensating JournalEntry immediately, the same shape as a Refund. If the dispute later resolves as won (`charge.dispute.closed`), a second JournalEntry reverses the provisional one. No seventh `chargeback_hold` account is introduced.

**Consequences:** Simpler chart of accounts, and correct in the common case, since most chargebacks are lost by the merchant. The cost: a Restaurant's Ledger briefly understates its true balance during the dispute-review window on the rarer chargebacks eventually won. Revisit with a dedicated held-funds account if chargeback volume ever makes that window operationally significant.

---

## ADR-017 — Compensating-Entry FK Placement: JournalEntry Owns Nullable Pointers to Refund/Chargeback/Adjustment
**Status:** Accepted (Founder decision, overriding the AI Technical Co-Founder's initial recommendation)

**Context:** Found while translating `DATABASE.md` into `schema.prisma` (Sprint 0). `DATABASE.md`'s `Refund`, `Chargeback`, and `Adjustment` entities each declare, in their **Relationships** line, "→ JournalEntry (the compensating entry)" — but none of their **Fields** lists includes a `journal_entry_id` (or any equivalent) column. A Prisma schema cannot leave a declared relationship unimplemented, so this had to be resolved to proceed — not silently, per `CLAUDE_RULES.md`.

Two directions were possible. The AI Technical Co-Founder's first draft proposed a single `journal_entry_id` (UNIQUE) on each of Refund/Chargeback/Adjustment, reasoning by analogy to `Transaction.payment_id` and `Tip.transaction_id`. **This was wrong, and the Founder caught it**: ADR-016 already establishes that a single `Chargeback` produces a *provisional* compensating `JournalEntry` immediately, and — if the dispute later resolves as won — a *second*, reversing `JournalEntry`. That is one Chargeback to many JournalEntries. A `UNIQUE journal_entry_id` on `Chargeback` cannot express a one-to-many relationship at all; the first draft would have silently blocked ADR-016's own documented flow the first time a real dispute was won.

**Decision:** `JournalEntry` owns three nullable FK columns — `refund_id`, `chargeback_id`, `adjustment_id` — mirroring the pattern already used for `JournalEntry.transaction_id`. This is a one-to-many relationship from each of Refund/Chargeback/Adjustment to JournalEntry, correctly allowing zero, one, or more than one compensating entry per row. Refund and Adjustment receive the identical shape for consistency, even though today's flows only ever produce exactly one JournalEntry for either — matching shapes for structurally similar relationships is worth more than a marginally tighter constraint on two of the three.

**Alternative rejected (the AI Technical Co-Founder's original recommendation):** a single, unique `journal_entry_id` FK living on Refund/Chargeback/Adjustment. Rejected because it cannot represent ADR-016's provisional-then-reversal flow for Chargeback — a correctness bug, not a style preference. The original reasoning ("keeps JournalEntry generic, undecorated by downstream entity types") is real but secondary to correctness: `JournalEntry.transaction_id` already establishes that JournalEntry pointing outward to what it compensates is the established pattern in this schema, not a new coupling.

**Consequences:** `schema.prisma` implements this. The one thing Prisma cannot enforce here: at most one of `refund_id` / `chargeback_id` / `adjustment_id` should be set on a given row, matching `entry_type`. Unlike the debit=credit invariant (ADR-002), this one *is* expressible as a plain single-row Postgres `CHECK` constraint (no deferred trigger needed, since it doesn't aggregate across rows) — recommended as a Sprint 1 migration addition alongside the ledger-balance trigger, not yet built.

---

## ADR-018 — Payment Mutability: Status and updated_at Are Mutable; Everything Else Is Immutable
**Status:** Accepted (Founder decision)

**Context:** Found while auditing `schema.prisma` against `DATABASE.md` (Sprint 0 audit, §6/§9).
`DATABASE.md`'s `Payment` entity gives an explicit Fields list with no `updated_at`, and its Rules
say "Immutable once created." Read literally, this means a failed, declined, or timed-out payment
attempt is written once and never updated to reflect that outcome — but `MASTERPLAN.md`'s Fraud
Prevention section explicitly requires detecting "repeated failed payments" as a fraud signal,
which is impossible if failures are invisible. This is a real contradiction between two documents,
not just an underspecified detail — flagged rather than resolved silently, per `CLAUDE_RULES.md`.

**Decision:** `Payment.status` is mutable and transitions exactly once, from `pending` to a
terminal state: `succeeded`, `failed`, `canceled`, or `declined`. `Payment.updated_at` is added to
record when that transition happens. `failed` (a processing error or timeout) and `declined` (the
card issuer explicitly rejected the charge) are kept as two distinct terminal states rather than
one, because they are different fraud signals in practice. Every other field on `Payment` —
`amount`, `restaurant_id`, `processor`, `processor_payment_id`, `currency`, `payment_method`,
`idempotency_key` — remains genuinely immutable once written. "Immutable once created"
(`DATABASE.md`) describes the payment's identity and economic facts, not its eventual outcome.

**Consequences:** `schema.prisma`'s `Payment` model gains `updated_at` and a fifth `PaymentStatus`
value, `DECLINED`. `DATABASE.md`'s `Payment` entity is updated to state this explicitly rather
than left to silently diverge from the schema. Sprint 5's Stripe webhook handling
(`payment_intent.succeeded`, `payment_intent.payment_failed`, etc. — `API_Contract.md`'s Incoming
Webhooks section) writes this one transition; nothing else ever updates a `Payment` row.

---

## Superseded / Retired
- **CTO Operating Manual** — superseded by ADR-011; content to be merged into `CLAUDE_RULES.md`, then removed from the repository.
