---
title: ARCHITECTURE_DECISIONS
version: 1.12.0
status: Active — twenty-six ADRs, all Accepted
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
**Status:** Accepted (revised in place — see "Revision" below; same principle as ADR-017/ADR-019: a correction to an already-accepted decision on new evidence, not a new decision)

**Context:** No money can move until each restaurant's connected account and onboarding state are tracked. Stripe's connected-account country and default currency are fixed at creation and cannot be changed afterward.

**Decision (original, Sprint 0):** `Restaurant` stores `stripe_account_id`, `onboarding_status`, `charges_enabled`, `payouts_enabled`, and `requirements_due`, mirroring Stripe's own Account object. For MVP, the connected account is attached at the Restaurant level — each location has its own payout account — rather than at Organization level, since Restaurant already represents one legal and tax entity (it carries `legal_name`, `vat_number`, `company_number`). Centralized org-level payouts for chains are a distinct, later feature, not a redesign of this decision.

**Revision — Accounts v2, not v1 (found while starting Sprint 3, confirmed empirically before touching `schema.prisma`, not assumed from documentation):** `charges_enabled` / `payouts_enabled` as flat booleans mirror Stripe's v1 Connect Accounts API (`POST /v1/accounts`). Stripe's current integration guidance states this is deprecated in favor of Accounts v2 (`POST /v2/core/accounts`), which replaces flat booleans with nested, per-payment-method capability statuses. Confirmed directly against a real Stripe test-mode account, not assumed: a `GET /v2/core/accounts/{id}` response has no `charges_enabled` field at all. The live equivalent is `configuration.merchant.capabilities.card_payments.status` — one of Stripe's own status strings (`active` / `pending` / `restricted` / `disabled`, or the capability is simply absent if never requested). Payout status lives at `configuration.merchant.capabilities.stripe_balance.payouts.status` — nested under `stripe_balance`, not a flat `payouts` capability the way v1's `payouts_enabled` implied. `requirements_due` is similarly not a flat array of requirement-name strings in v2: the real shape is `requirements.entries[]`, an array of objects (`description`, `impact.restricts_capabilities[]`, `minimum_deadline`, `requested_reasons[]`) — captured directly from a live response, not guessed.

**Consequences:** `schema.prisma`'s `Restaurant` model drops `charges_enabled` / `payouts_enabled` (`Boolean`) for `card_payments_status` / `payouts_status` (`String?`, mirroring Stripe's own capability-status vocabulary directly). Deliberately not a Prisma enum: this vocabulary belongs to Stripe, not to us, and could grow without warning — constraining it to an enum would force a migration every time Stripe adds a status value. `requirements_due` (`Json?`) keeps its name and type, now holding the real `requirements.entries[]` shape instead of a guessed one. `onboarding_status` (our own derived `NOT_STARTED` / `IN_PROGRESS` / `COMPLETE` / `RESTRICTED` enum, still ours to define) is unchanged in shape — only in how it gets computed, from the v2 capability statuses and requirements rather than the old v1 booleans. The onboarding flow (Sprint 3) still must explicitly handle "restaurant created, Stripe onboarding incomplete" as a real state, not treat restaurant creation and payment-readiness as the same event. See ADR-014's own revision for the account-type change (Express → Standard-equivalent) these fields also had to account for.

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

## ADR-014 — Stripe Connect Account Type: Standard-equivalent (`dashboard: "full"`)
**Status:** Accepted (revised in place — see "Revision" below; same principle as ADR-017/ADR-019: a correction to an already-accepted decision on new evidence, not a new decision)

**Context:** Restaurant Onboarding (ADR-009) established that each Restaurant owns its own Stripe Connect account, but never specified which of Stripe's account types — Standard, Express, or Custom — to use. Custom means building the entire onboarding UI ourselves; Standard gives the restaurant full access to their own Stripe Dashboard; Express sits between the two.

**Decision (original, Sprint 0):** Express. Stripe hosts the KYC and bank-account collection flow directly through Account Links — none of that ever reaches our servers, keeping onboarding-related compliance scope on Stripe rather than us. The Restaurant Portal keeps its own branding for everything else; only the onboarding step itself is Stripe-hosted.

**Revision — Standard-equivalent (`dashboard: "full"`), not Express (found while starting Sprint 3, verified empirically against a live Stripe test account, not assumed by symmetry with ADR-009's v1→v2 finding or by reading documentation):** the original decision weighed Express vs Standard as a UX/branding trade-off only. What it missed: **who bears financial liability for a restaurant's fraud and chargebacks is not a UX choice — Stripe's v2 API enforces it at account-creation time, not just as a recommendation.**

Confirmed by real `POST /v2/core/accounts` calls against a live Stripe test-mode account — a full 2×2 matrix, not one data point:

| `dashboard` | `fees_collector` | `losses_collector` | Result |
|---|---|---|---|
| `express` | `application` | `stripe` | **HTTP 400** — `account_controller_unsupported_configuration`, `invalid_permutation` echoed back in the response |
| `express` | `application` | `application` | **HTTP 200** — account created (`acct_1U0oOwB7fPGdeRuB`) |
| `full` | `stripe` | `stripe` | **HTTP 200** — account created (`acct_1U0oaoB7fPOaqj74`) |
| `full` | `application` | `application` | **HTTP 400** — `account_controller_unsupported_configuration`, `invalid_permutation` echoed back in the response |

Express *only* accepts `losses_collector: "application"` — the platform absorbs restaurant-side fraud/chargeback losses. Standard-equivalent (`dashboard: "full"`) *only* accepts `losses_collector: "stripe"` — Stripe absorbs them. There is no configuration where Express lets Stripe hold that liability instead of the platform; the API rejects it outright. This settles a question the original ADR never asked.

Onboarding mechanism does **not** change between the two, confirmed by calling it against both a live `dashboard: "express"` and a live `dashboard: "full"` test account: the same `POST /v1/account_links` call (`type: "account_onboarding"`, same `refresh_url` / `return_url` parameters) returns `200` for both. The only observed difference is the URL Stripe hands back — `.../setup/e/...` for Express, `.../setup/s/...` for Standard-equivalent — and presumably the hosted UI/branding behind it. Our backend code for generating and redirecting to the onboarding link is identical either way; nothing about the Restaurant Portal's integration changes.

**Decision (revised):** Standard-equivalent, `dashboard: "full"`, `configuration.merchant` requested (Restaurant is merchant of record for its own sales, consistent with ADR-002's chart of accounts crediting Restaurant Revenue Payable directly). The restaurant — not Hospitality OS — bears its own fraud and chargeback losses, the financially conservative default for a platform whose own margin is a small take rate, not a risk buffer sized to absorb merchant-side fraud.

**Consequences:** Restaurant Portal's onboarding UI code is unaffected (identical Account Links flow). A restaurant now gets full access to its own Stripe Dashboard rather than the lighter Express-branded one — a support/UX trade-off accepted with the liability data in view, not overlooked as before. The specific charge pattern (direct charges on the connected account vs. destination charges from the platform account) is Sprint 5's decision when the Payment/Ledger write path is actually built — this ADR settles the account type and liability question, not the charge pattern.

**Charge pattern, settled (found while building Sprint 5, confirmed against Stripe's own current platform-classification guidance, not guessed):** Direct charges — the PaymentIntent is created directly on the Restaurant's connected account (`Stripe-Account` request header/param), with the Restaurant as merchant of record. This isn't a fresh decision so much as making explicit what this ADR's own already-accepted configuration already implies: Stripe's current guidance classifies `dashboard: "full"` + `configuration.merchant` + "the seller is merchant of record for their own sales" as the **SaaS** pattern, whose charge mechanism is Direct charges — as distinct from the **Marketplace** pattern (`dashboard: "express"`, platform is merchant of record, Destination charges), which this ADR explicitly rejected above. `application_fee_amount` on the PaymentIntent is the platform-revenue mechanism for Direct charges, exactly as it is for Destination charges — no different fee wiring needed depending on which was chosen. `payment_method_types` is deliberately never set on the PaymentIntent (Stripe's own current guidance: omitting it enables dynamic, Dashboard-configured payment methods); the one documented exception, `card_present` for physical Terminal hardware, doesn't apply here — this is Stripe.js client-side confirmation (ADR-015), not a card reader.

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

## ADR-019 — Refresh Token Storage: Stateless JWT + Redis Revocation, Family-Wide on Reuse
**Status:** Accepted (flagged during implementation, per `CLAUDE_RULES.md`'s "Documentation First" — not decided silently; revised once, see below)

**Context:** Found while building Sprint 2 (Authentication). `DATABASE.md`'s Core Domain enumerates exactly twenty entities and never mentions a RefreshToken table — unlike entities deliberately excluded from MVP, which are always named explicitly under "Future Entities" (`Withdrawal`, `Settlement`, etc.). This reads as an oversight, not a deliberate exclusion: `API_Contract.md`'s `POST /auth/login` ("returns Access Token, Refresh Token...") and `IMPLEMENTATION_PLAN.md`'s Sprint 2 ("Refresh Token... JWT refresh works") both treat refresh tokens as real, in-scope functionality, not a Future Entity.

**Decision:** Refresh tokens are stateless signed JWTs — a separate secret and a longer TTL than access tokens — not a persisted Postgres row. Every `POST /auth/refresh` call revokes the presented refresh token and issues a new pair, so a leaked refresh token is worthless the moment it's used once (rotation).

**Revision — reuse detection, family-wide (Founder-requested, reviewing the code directly rather than the description of it):** the original version of this decision revoked only the individual token's `jti` on rotation. The Founder asked directly whether replaying an already-rotated-out token revoked just that token or the whole chain descended from it — the honest answer, checked against the code rather than assumed, was "just that token." That is the textbook-wrong response: replaying an already-superseded refresh token is the standard signature of a stolen token racing the legitimate client, and rejecting only the replay leaves the legitimate session's current token (and, if it really was theft, the attacker's) both still valid.

Fixed: every refresh token now also carries a `familyId`, generated once at login/register and carried forward unchanged across every rotation descended from that login. Revocation is tracked in Redis two ways — by individual `jti` (the routine "this exact token was rotated out" case) and by `familyId` (set the moment a replay of an already-revoked `jti` is detected). A revoked family invalidates every token descended from that login, present or future, not just the one being replayed. Verified against real HTTP endpoints, not only unit tests: rotate → replay the old token → both the old token and the newer, never-replayed token are rejected by `POST /auth/refresh`.

The detection moment itself is now distinguishable from an ordinary already-revoked-family rejection (`RefreshTokenReuseDetectedError`, not a generic 401), specifically so it can be written to `AuditLog` as its own action — `refresh_token_reuse_detected` — per `CLAUDE_RULES.md`'s Logging Philosophy ("Always log: ... Security Events"). Confirmed live: the row lands with the correct `user_id`, `familyId` in `metadata`, and the requesting IP/user-agent; a subsequent rejection of the same family's other token does not produce a second row, since it isn't a new detection.

**Consequences:** No schema migration was needed for Sprint 2 (still no RefreshToken table — family tracking is a second Redis key, not a new Postgres entity). Revocation and family-revocation state both live only in Redis — consistent with `SYSTEM_ARCHITECTURE.md`'s Caching Strategy, which already treats Redis as appropriate for short-lived, non-financial state and explicitly wrong for anything that must survive as a source of truth (Wallet, Restaurant balance). Accepted risk, unchanged from the original decision: a Redis flush would silently un-revoke every outstanding refresh token and family flag (they'd still verify by signature until natural expiry, typically within days) — acceptable for MVP; revisit if refresh-token revocation ever needs to survive a Redis outage.

---

## ADR-020 — Membership Invitation: Separate Entity, Never a Passwordless User
**Status:** Accepted (Founder decision)

**Context:** Found while starting Sprint 4 (Membership Module). `MASTERPLAN.md`'s own User Journey states the intended flow explicitly: *"Waiter: Receives Invitation → Creates Password → Logs In → Receives Tips → Views Wallet."* Read literally, an invited person exists — and can be invited, assigned a Role, a Restaurant — before they have a password. But `User.password_hash` is `NOT NULL` (Sprint 0 schema, unchanged since), and `DATABASE.md`'s Core Domain lists exactly twenty entities with no `Invitation` anywhere — not among the twenty, not under Future Entities either. A real contradiction between `MASTERPLAN.md`'s own stated user journey and the schema it's supposed to run on, found before writing any Sprint 4 code, not after — flagged per `CLAUDE_RULES.md` rather than resolved silently or guessed.

Two directions were possible: make `User.password_hash` nullable and add invitation-state fields directly to `User`, or keep `User` exactly as it is and represent "invited, not yet a real account" as an entirely separate entity.

**Decision:** `MembershipInvitation` is a new, standalone entity (`DATABASE.md`'s twenty-first). `User.password_hash` stays `NOT NULL`, untouched. No `User` row is ever created for someone who hasn't set a password — a `MembershipInvitation` row exists in its place until accepted, at which point `User` (if one doesn't already exist for that email) and `Membership` are created together, atomically, in the same transaction as the acceptance itself.

**Why not the nullable-`password_hash` alternative:** `User.password_hash` is read by the single most security-sensitive code path in the system — `AuthService.login()`, `JwtAuthGuard`'s user lookup — both already built, tested, and live-verified across two sprints on the invariant that every `User` row is a fully real, authenticatable account. Making it nullable doesn't just widen a column; it means every future reader of `User.passwordHash` has to remember to ask "or is this one mid-invitation?" — a new edge case injected into exactly the code this project has been most careful about, for the benefit of a feature (invitations) that has nothing to do with login itself. A separate entity keeps that invariant intact and keeps the new, less-hardened invitation logic in its own module, not woven into the one everything else depends on.

**Token handling — hashed, never stored comparably in plaintext, same principle as `password_hash` and ADR-019's Redis-tracked refresh-token state:** `MembershipInvitation` stores `token_hash`, never the raw token. The raw token exists exactly once, at creation, handed back to the inviter in the API response (there is no email-sending infrastructure anywhere in this project yet — undocumented, so not something Sprint 4 invents; the inviter is responsible for relaying the link until a real provider is introduced with its own ADR). Verifying an incoming token against `token_hash` follows the same shape as verifying a password against `password_hash`: look up the candidate row(s) by a known, non-secret field (`email`), then hash-compare the presented token against each candidate's `token_hash` — never a plaintext equality check, and never a query that tries to look a row up *by* the secret itself.

**`invited_by` (FK to `User`):** kept as its own field, not derived by joining through `AuditLog`. `AuditLog` exists for compliance and audit trail (`DATABASE.md`, `AuditLog`'s own Purpose: "Permanent history of who did what") — a UI screen listing pending invitations and who sent each one is a direct, frequent read, not an audit reconstruction, and shouldn't need to join through the audit log to render.

**Consequences:** `schema.prisma` gains a new model (`DATABASE.md`'s twenty-first entity, full definition there). `POST /memberships` (API_Contract.md) now creates a `MembershipInvitation`, not a `Membership` directly — including for an email that already belongs to an existing `User`, uniformly: the existing person still explicitly accepts before a `Membership` is attached to them, rather than one being silently created because someone else typed their email into a form. `DATABASE.md`'s existing Membership Rule — *"Inviting an email address that already belongs to a User attaches a new Membership to that existing User — it never creates a duplicate User row"* — still holds exactly as written; it now happens at acceptance time instead of at invite time, and the "never a duplicate `User` row" half of that sentence is exactly what `MembershipInvitation` existing as a separate entity is *for*.

---

## ADR-021 — Platform Fee: Basis Points, Global Rate, Restaurant Revenue Only
**Status:** Accepted (Founder decision)

**Context:** ADR-002's chart of accounts has carried a `PLATFORM_FEE_REVENUE` account since Sprint 1, and ADR-014's own addendum settled the charge pattern (Direct charges, `application_fee_amount` as the fee mechanism) — but no document anywhere named an actual rate. `MASTERPLAN.md` mentions "Platform Fees" only as a concept ("Restaurant revenue belongs to the restaurant... Processing Fees. Platform Fees.") and the only percentages it names (10%/15%/20%) are customer-facing tip presets, unrelated to platform revenue. Building Sprint 5's `payment_intent.succeeded` handler was blocked on this exact gap — a real number, not guessable, flagged rather than invented.

**Decision:** 100 basis points (1.00%), as `DEFAULT_PLATFORM_FEE_BASIS_POINTS` — a required environment variable (`env.validation.ts`, no `.default()`), not a database field: a fee rate is a business decision that must never be silently assumed at boot, the same reasoning `STRIPE_SECRET_KEY` already gets. Basis points (integer, 0–10,000), not a percentage float — same reasoning as ADR-001's `BIGINT` minor units for money itself: a rate that will get multiplied against money must never be a float. The fee applies to **Restaurant Revenue only, excluding tips** — a tip is never platform revenue (Sprint 6 introduces `Tip`; this split has nothing to reduce yet, since Sprint 5 has no tip flow).

**Naive extension deferred, not built now (Founder's own framing, matching ADR-007's precedent exactly):** a full `PlatformFeePolicy`/configuration-service abstraction was considered and explicitly rejected for now — a naive later extension (a nullable `feeBasisPoints` column on `Restaurant`, falling back to `DEFAULT_PLATFORM_FEE_BASIS_POINTS` when unset) would cost about the same as building the abstraction today, so the abstraction doesn't earn its cost yet. The "Default" in the env var's own name anticipates that extension without building it prematurely — the same "flexibility on demand of the first real restaurant that needs it, not in advance" principle ADR-007 already established for tip allocation strategies.

**Integer arithmetic, verified, not assumed correct:** `splitPlatformFee()` (`src/payment/platform-fee.util.ts`) computes `feeAmount` first via `BigInt` floor division (`(grossAmount * basisPoints) / 10_000n` — `BigInt` division always truncates toward zero, never a float, never `Math.round`), then derives `restaurantRevenue` by **subtraction** (`grossAmount - feeAmount`), never by an independent second division. This is the same discipline ADR-001 requires for the largest remainder method: two independently-rounded parts can each round down and sum to less than the whole (confirmed with a real discriminating case — `grossAmount=3n, basisPoints=100`: an independent-division approach yields `feeAmount=0n, restaurantRevenue=2n`, one minor unit short of `3n`; subtraction-derived yields `restaurantRevenue=3n`, summing exactly). The same function computes the amount passed to Stripe as `application_fee_amount` (`PaymentService.createPaymentIntent`) and the amount posted to `PLATFORM_FEE_REVENUE` in the Ledger (`WebhooksService.handlePaymentIntentSucceeded`) — one function, one rate, two call sites, never two independently-computed numbers that could drift apart.

**Consequences:** No schema migration — the rate lives in config, not a table. `payment_intent.succeeded` now posts a 3-line `JournalEntry` (`PROCESSOR_CLEARING` debit = full amount; `RESTAURANT_REVENUE_PAYABLE` credit = amount minus fee; `PLATFORM_FEE_REVENUE` credit = fee, omitted entirely when it rounds to zero rather than posting a meaningless zero-amount line) instead of Sprint 5's earlier fee-independent 2-line version. Live-verified against a real payment: gross 10,000 minor units → `platform_fee_revenue` credit of exactly 100, `restaurant_revenue_payable` credit of exactly 9,900, summing to the debit exactly.

**Known follow-up, not resolved by this decision, flagged rather than silently assumed (tracked in `THREAT_MODEL.md`, "Open, Not Answered"):** `charge.refunded` / `charge.dispute.*` compensating entries (ADR-008/ADR-016) still reverse the **full** refunded/disputed amount out of `RESTAURANT_REVENUE_PAYABLE` — unchanged from before this ADR, and now a real question rather than a moot one: a full refund of a fee-bearing Transaction debits more from `RESTAURANT_REVENUE_PAYABLE` than that specific capture ever credited to it (the fee's share went to `PLATFORM_FEE_REVENUE`, not `RESTAURANT_REVENUE_PAYABLE`), which is fine at the level of each individual `JournalEntry` (every entry is still internally balanced, verified by the trigger) but means the *cumulative* `RESTAURANT_REVENUE_PAYABLE` balance for a fully-refunded, fee-bearing Transaction can go negative for that Transaction specifically.

**Founder's stated direction, not yet implemented:** the platform fee should be proportionally clawed back on refund, matching Stripe's own optional `refund_application_fee` parameter — the eventual answer is known, Sprint 5's own task scope simply didn't include building it (capture-side split and the rate itself only, not refund/fee interaction). Revisit before this matters in practice — the first real refund against a fee-bearing payment.

---

## ADR-022 — Tip Handling: Client-Submitted tipAmount, Bill-Only Fee Base, Payer-Attributed Recipient, Two-Entry Posting
**Status:** Accepted (Founder decision)

**Context:** Sprint 6 (Tips) required resolving four real gaps no prior document answered: how a tip amount enters the system at all (UX_MAP.md's Payment Flow shows one combined "Card Payment" step after "Choose Tip," but `POST /payments` only ever accepted a single `amount`, with no bill/tip split); how ADR-021's "Restaurant Revenue only, excluding tips" rule stays true once a single `Payment.amount` can contain both (the existing fee split ran on the full amount); who the tip's recipient is and when that's known (no terminal/waiter-assignment mechanism exists anywhere); and the Ledger posting mechanics for crediting a specific Membership's Wallet share of `TIP_PAYABLE` (ADR-002's chart of accounts has the liability account; nothing wrote to it). Flagged rather than guessed, per `CLAUDE_RULES.md`'s "Ask Better Questions."

**Decision:**

`Payment` gains `tipAmount` (BigInt, minor units, default 0) — the caller-submitted tip portion of `amount`. `amount` itself is unchanged in meaning: it remains the full amount charged to the card, bill and tip combined, matching what Stripe's PaymentIntent actually processes as one charge and matching UX_MAP.md's single "Card Payment" step. Validated `tipAmount <= amount` at request time (`createPaymentSchema`).

`Payment` gains a nullable `waiterMembershipId` FK to `Membership`, captured from the authenticated caller's own identity at `POST /payments` time — specifically, the Membership that actually grants that caller `payments.manage` reachability to the target Restaurant, the same one `PaymentService` already resolves to authorize the request. No separate terminal-to-waiter or table-to-waiter attribution mechanism is introduced: the person operating the payment terminal for this transaction is the tip's recipient, by construction. Always captured, whether or not `tipAmount` is nonzero — a simpler invariant than conditionally setting it, and harmless since it's only read when a tip exists.

Fee computation everywhere now derives from `billAmount = amount - tipAmount`, never from `amount` directly — both call sites that run `splitPlatformFee()` (`PaymentService.createPaymentIntent`, computing Stripe's own `application_fee_amount`, and `WebhooksService.handlePaymentIntentSucceeded`, computing what posts to `PLATFORM_FEE_REVENUE`) changed identically, preserving ADR-021's own stated invariant — "one function, one rate, two call sites, never two independently-computed numbers that could drift apart" — now with `billAmount` as the shared input instead of `amount`.

Ledger posting is two separate `JournalEntry` rows, not one combined entry, both inside the same database transaction as the existing `payment_intent.succeeded` write (atomic with it — either the whole thing lands or none of it does, same reasoning as the existing `Payment.update` + `Transaction.create` + Ledger-write atomicity):

- `PAYMENT_CAPTURED` gains a fourth line when `tipAmount > 0`: `TIP_PAYABLE` credit for `tipAmount`, alongside the existing `PROCESSOR_CLEARING` debit (unchanged, still the full `payment.amount`), `RESTAURANT_REVENUE_PAYABLE` credit (now derived from `billAmount`), and `PLATFORM_FEE_REVENUE` credit (now derived from `billAmount`, still omitted when it rounds to zero). Balances by construction: debit `amount` = `billAmount + tipAmount`; credits `restaurantRevenue + feeAmount + tipAmount` = `billAmount + tipAmount` (since `restaurantRevenue + feeAmount = billAmount` always, per `splitPlatformFee`'s own subtraction-derived guarantee).
- A second, immediately following `TIP_ALLOCATED` entry (same `transactionId`, no `refundId`/`chargebackId`/`adjustmentId` — matches `ledger-balance.util.ts`'s existing `TIP_ALLOCATED: null` compensating-entity mapping) debits `TIP_PAYABLE` for `tipAmount` with no `membershipId` — reversing the general liability `PAYMENT_CAPTURED` just created — and credits `TIP_PAYABLE` again for the identical total, this time as one-or-more lines each carrying a specific `membershipId`, sourced from a new `TipAllocationStrategy` interface rather than hardcoded inline. Same account on both sides of this entry; `membershipId` is the only discriminator, matching `DATABASE.md`'s own `LedgerLine` rule that `membershipId` is what makes a line contribute to a specific person's Wallet projection (ADR-007).

`TipAllocationStrategy` is the interface `IMPLEMENTATION_PLAN.md`'s Sprint 6 task list already calls for by name, genuinely load-bearing rather than decorative: `allocate(tipAmount, payingMembershipId): TipAllocationLine[]`. MVP's only implementation, `IndividualTipAllocationStrategy`, always returns exactly one line (the full `tipAmount` to the payer's own `waiterMembershipId`) — matching ADR-007's already-accepted Individual strategy. `Pool`/`Shift`/`Percentage`/`Role-based` strategies (ADR-007, still not implemented) would return more than one line from the same method signature — the `TIP_ALLOCATED` entry's line-construction code doesn't change when one does, only which strategy is selected, which is exactly Sprint 6's own Definition of Done: "Adding a second allocation strategy later requires no schema change."

A `Tip` row (`DATABASE.md`) is created only when `tipAmount > 0` — `Transaction → zero-or-one Tip` is the schema's own cardinality, so no tip means no row, not a zero-amount one. Written with `status: ALLOCATED` directly, not `PENDING` then transitioned: both `JournalEntry` rows land together, atomically, in the same transaction as the `Tip` row itself, so there is no real window during which the tip exists but isn't yet allocated for MVP's Individual strategy to observe.

**Consequences:** Migration adds `tip_amount` (BIGINT, default 0) and `waiter_membership_id` (nullable UUID FK) to `payment`. `DATABASE.md`'s `Payment` entity and `API_Contract.md`'s Create Payment section both updated to state the new field. The pre-existing fee-computation bug this decision fixes was never shipped to production — Sprint 5 had no tip field yet, so `amount` and `billAmount` were always identical up to this point; still a real defect that a naive Sprint 6 implementation could easily have reintroduced by extending `amount`'s meaning without updating both `splitPlatformFee()` call sites in lockstep, which is exactly why both were fixed together, in the same pass, rather than one now and one "later."

---

## ADR-023 — Refund Proportional Reversal: Fee and Tip Clawed Back with Restaurant Revenue, Not Left Standing
**Status:** Accepted (Founder decision)

**Context:** ADR-021 already named this gap and explicitly deferred it — its own "Known follow-up" section: *"charge.refunded / charge.dispute.* compensating entries... still reverse the full refunded/disputed amount out of RESTAURANT_REVENUE_PAYABLE... the cumulative RESTAURANT_REVENUE_PAYABLE balance for a fully-refunded, fee-bearing Transaction can go negative for that Transaction specifically,"* and its "Founder's stated direction": *"the platform fee should be proportionally clawed back on refund... revisit... the first real refund against a fee-bearing payment."* ADR-022 (Tip Handling) did **not** itself flag this — it introduced `TIP_PAYABLE`'s per-membership credit without discussing what a refund against a tip-bearing Payment should do to it, a real gap in that ADR, not one it predicted.

The first real refund against a tip-bearing payment, live-verified this session (real Stripe test-mode PaymentIntent, `amount=2000, tipAmount=500` → real signed `payment_intent.succeeded` → real signed `charge.refunded` for the full `2000`), confirmed the gap was not theoretical: `RESTAURANT_REVENUE_PAYABLE` for that Transaction went to **-515** (debited the full `2000` against a `1485` credit it never received more of), `PLATFORM_FEE_REVENUE` kept its `15` fee on a fully-refunded payment, and the waiter's own `TIP_PAYABLE` credit of `500` stood completely untouched — the customer got their tip back in full while the Wallet projection (`TipService.findMine`, reading the Ledger directly, no cache) still showed it as allocated.

**Decision:** `handleChargeRefunded` now reverses three accounts proportionally instead of one unconditionally: `RESTAURANT_REVENUE_PAYABLE`, `PLATFORM_FEE_REVENUE`, and `TIP_PAYABLE` (credited back at the specific `waiterMembershipId` the tip was originally allocated to — never the general `membershipId: null` line, which no longer exists once `TIP_ALLOCATED` has run).

The proportion is `cumulativeRefunded / originalGrossAmount`, applied to the ORIGINAL capture-time amounts, then reduced to a per-event delta the same way `newRefundAmount` itself already was in Sprint 5 (`cumulative − previously recorded`) — now for three accounts, not one:

- `cumulativeTipReversed = floor(originalTipAmount × cumulativeRefunded / originalGrossAmount)` — `originalTipAmount` is `payment.tipAmount`, trusted directly, same as `handlePaymentIntentSucceeded` already trusts it.
- `cumulativeFeeReversed = floor(originalFeeAmount × cumulativeRefunded / originalGrossAmount)` — `originalFeeAmount` is read back from the actual `PLATFORM_FEE_REVENUE` credit line `PAYMENT_CAPTURED` posted for this Transaction, **not** re-derived via `splitPlatformFee()` against the *current* `DEFAULT_PLATFORM_FEE_BASIS_POINTS`. Deliberate: the basis-point rate is a mutable env var (ADR-021), and a refund can land long after capture — recomputing with today's rate would reverse the wrong amount if the rate changed in between, silently reintroducing exactly the kind of imbalance this ADR exists to close. Reading the Ledger's own historical record instead is both simpler and immune to that drift, matching ADR-002 (Ledger as Source of Truth) more literally than recomputation would.
- `cumulativeRevenueReversed = cumulativeRefunded − cumulativeTipReversed − cumulativeFeeReversed` — the residual, never its own independent division. Same discipline `splitPlatformFee()` itself already established (ADR-021) and now applied a second time: two independently-floored shares can each round down and leave a remainder; deriving the third by subtraction is what keeps the three reversed shares summing to exactly `cumulativeRefunded`, which `LedgerService.postJournalEntry`'s own balance check requires regardless.

"Already reversed per account" (the subtrahend for each delta) is read back from prior `REFUND_ISSUED` `LedgerLine` rows for this Transaction — not a new stored running total. Same reasoning as reading `originalFeeAmount` from the Ledger: the compensating history the deltas need already exists as `LedgerLine` rows; a parallel stored total would be a second, independently-maintainable copy of a fact the Ledger already owns.

Each of the three debit lines is omitted when its delta rounds to exactly zero — same zero-line-omission convention `PAYMENT_CAPTURED` already uses for `PLATFORM_FEE_REVENUE` and `TIP_PAYABLE`. `REFUND_CONTRA`'s credit is always posted at the full `newRefundAmount`, unconditionally — the actual cash Stripe returned to the customer, never split.

`Refund.tipRefunded` is now computed per event — `tipDelta > 0n` for *this specific* refund, not the cumulative total — replacing the Sprint 5 hardcoded `false` that predated `Tip` existing at all.

**Verification case (this ADR's own worked example, and this session's regression test):** `originalGrossAmount=2000, originalTipAmount=500, originalFeeAmount=15` (`billAmount=1500` at 1.00%). A full refund (`cumulativeRefunded=2000`, fraction exactly `1`) gives `cumulativeTipReversed=500`, `cumulativeFeeReversed=15`, `cumulativeRevenueReversed=2000−500−15=1485` — the exact numbers the capture side posted; all three accounts net to zero for this Transaction, nothing left standing on either side. Live re-verified against the same real payment this ADR's Context section describes: after applying this decision, `RESTAURANT_REVENUE_PAYABLE`, `PLATFORM_FEE_REVENUE`, and `TIP_PAYABLE` each summed to exactly zero for that Transaction.

**Revised the same session, before the sprint closed — chargebacks (`charge.dispute.*`) included, not deferred:** the first version of this ADR explicitly left `handleDisputeCreated`/`handleDisputeClosed` untouched, flagged as a distinct decision. Checking that framing against `DATABASE.md`'s own Chargeback Rules text — *"Same compensating-entry rule as Refund"*, written at Sprint 0 and never contradicted since — found the code did not actually match that already-standing claim: `handleDisputeCreated` debited only `RESTAURANT_REVENUE_PAYABLE` for the full dispute amount, and `handleDisputeClosed`'s WON path mirrored only that same single account. Not a new business question deferred for later, as first framed — a documented rule the code simply hadn't caught up to, the same shape as this ADR's own original gap, so fixed the same way rather than opened as a fresh decision.

`handleDisputeCreated` now splits `dispute.amount` across the same three accounts, via the same `splitProportionally()` the refund path uses. `handleDisputeClosed`'s WON path reverses the *exact* per-account amounts the provisional entry posted — read back from that entry's own `LedgerLine` rows, not recomputed, so a WON reversal can never disagree with what `dispute.created` actually debited (LOST posts nothing further, unchanged). Both `getOriginalCapturedFeeAmount()` and `splitProportionally()` are shared private helpers now, one implementation for both triggers, not two independently-maintained copies of the same formula. Live-verified via the same regression-test discipline as the refund path (`webhooks.service.spec.ts`): a dispute opened on a `tipAmount=500` Transaction debits `RESTAURANT_REVENUE_PAYABLE`/`PLATFORM_FEE_REVENUE`/`TIP_PAYABLE` at `1485`/`15`/`500`, and a WON closure reverses all three back to net zero, `TIP_PAYABLE` included.

**Consequences:** `PROCESSOR_CLEARING` is reversed by neither refunds nor chargebacks, before or after this decision — a separate, older, not-tip-specific gap, tracked as its own `THREAT_MODEL.md` "Open, Not Answered" entry rather than folded into this ADR. `DATABASE.md`'s `Refund` entity Rules text updated to name all three reversed accounts, not just two; its `Chargeback` entity Rules text needed no change — *"Same compensating-entry rule as Refund"* was already correct, only the code lagged it. `THREAT_MODEL.md`'s "Whether the platform fee is clawed back on refund" entry moves from Open to Closed, citing this ADR — its closing note now covers both triggers, not just refunds.

---

## ADR-024 — Wallet Projection: Full Recompute from LedgerLine, Available-Only Balance Until Withdrawal Exists
**Status:** Accepted (Founder decision)

**Context:** Sprint 7 (Wallet, `IMPLEMENTATION_PLAN.md`) is the first real consumer `OutboxPollerService` has ever dispatched to — before this, it ran, polled, and logged "no handler registered yet" (`EVENT_CATALOG.md`), a deliberate skeleton since Sprint 1 with nothing to project. Building the projection required three decisions no prior document answered: how the projection itself should compute a balance (incremental, or from scratch), what "Pending" versus "Available" means when `MASTERPLAN.md` lists both fields but never defines the split, and who besides a Wallet's own holder may view it, when `seed.ts`'s own comment already states *"a waiter's own Wallet/Tips views aren't gated by this Permission set in MVP scope"* without saying what governs access instead. Flagged rather than guessed, per `CLAUDE_RULES.md`'s "Ask Better Questions."

**Decision 1 — full recompute, not incremental:** `WalletProjectionService.recomputeBalance(membershipId)` re-derives a Wallet's `available_balance` from `SUM(LedgerLine.amount)` over that Membership's entire history, every time, rather than applying a `+delta`/`-delta` to the stored value. Idempotent by construction: replaying the same Outbox event, or rebuilding a deleted row from zero, produces the identical result through the exact same code path — not a separate "rebuild" mode, which is also this Sprint's own Definition of Done ("A Wallet can be deleted and rebuilt from `LedgerLine` alone and match exactly"). Cost, stated explicitly rather than left implicit: **O(n)** in that Membership's own `LedgerLine` history on every call, not O(1). A deliberate MVP-scale tradeoff — a real Membership's tip history is small — not a forgotten optimization; revisit with an incremental/checkpointed scheme only if a real Membership's history ever grows large enough for this to show up in practice.

**Decision 2 — `pending_balance` stays 0 for MVP:** not because nothing is conceptually "pending" — because `Withdrawal` doesn't exist yet (`IMPLEMENTATION_PLAN.md` Sprint 7: "Future Withdrawals Placeholder" only). With no way to cash anything out of a Wallet at all, "available" and "pending" would be labeling the identical, equally-uncashable balance two different ways — a display split with no monetary meaning until `Withdrawal` ships and gives the distinction something real to distinguish. The field stays in `schema.prisma` for that future, always written `0` until then.

**Decision 3 — reachability-scoped access, not permission-gated:** `GET /wallets/{id}` and `.../transactions` use the same reachability rule already established for `PaymentService`/`TipService`/`RestaurantService`/`MembershipService` (ADR-005) — the Wallet's own Membership, or a Membership reaching that Wallet's Restaurant (org-wide same-Organization, or restaurant-scoped same-Restaurant) — e.g. an Owner viewing an employee's Wallet on the Employee Details screen (`UX_MAP.md`). An org-wide Wallet holder (`restaurantId` null — e.g. an Owner who personally took a payment) has no Restaurant to check reachability against, so nobody but that Membership's own holder can view it — never widened to "any org-wide Membership anywhere," the exact bug shape `CLAUDE_RULES.md`'s Architecture Review paragraph now requires checking for on every access check of this shape.

**Decision 4 — no handler registry:** `OutboxPollerService` injects `WalletProjectionService` directly; `OutboxModule` imports `WalletModule`. Wallet is the only real Outbox consumer that exists yet (Restaurant/Analytics projections are Sprint 8/9+, `SYSTEM_ARCHITECTURE.md`'s own roadmap) — a plugin/handler-registry abstraction has nothing to be generic over until a second real consumer lands, the same "flexibility on demand of the first real need, not in advance" precedent as ADR-007 (tip allocation strategies) and ADR-021 (`PlatformFeePolicy`).

**A real bug found and fixed building this, not by a test:** the first implementation cast `event.payload` and destructured `journalEntryId` without validating it — Prisma treats `where: { journalEntryId: undefined }` as "omit this filter," not an error, so a malformed payload (missing `journalEntryId`) made the projection match and attempt to recompute *every* Membership's balance in the database, instead of failing fast. Not hypothetical: `ledger.service.spec.ts`'s own atomicity test permanently seeds a real `OutboxEvent` with `payload: {}` (a `"TestMarker"` row proving the write lands in the same transaction as the Ledger write — correct for that test's own purpose, nothing to do with Wallet), which is exactly the shape that triggered the runaway scan the first time this dispatched against the real dev database. Fixed by validating `journalEntryId` is a non-empty string before using it, throwing immediately otherwise — loud failure over a silent, unscoped full-table operation (`CLAUDE_RULES.md`, Error Philosophy).

**Consequences:** `OutboxPollerService.dispatch()` now marks `published_at` and handles the projection in one atomic transaction, and only increments `attempts` on actual failure — the pre-Sprint-7 skeleton incremented it unconditionally, which stops here. `EVENT_CATALOG.md` updated in the same pass: `tip_allocated` corrected from "not yet implemented" (stale since Sprint 6 actually shipped it) to real and live, and the Consumers section's "no handler registered yet" / "Sprint 7 hasn't given the Outbox a consumer yet" language replaced with the real, current mechanism. `SYSTEM_ARCHITECTURE.md` notes the O(n)-per-event recompute cost explicitly, next to the Wallet consumer becoming real. `THREAT_MODEL.md` gains a new "Open, Not Answered" entry: the amount shown as "Available" can still be clawed back later through the already-existing ADR-023 chargeback mechanism — not material today since `Withdrawal` doesn't exist to make it cashable, but must be reconsidered before `Withdrawal` enters scope, not after. A new `WITHDRAWAL_NOT_AVAILABLE` error code (HTTP 501) and a Wallet-scoped 501 status entry answer `POST /wallets/{id}/withdrawals` honestly rather than 404ing as if the route doesn't exist.

---

## ADR-025 — Transaction Breakdown: All JournalEntry, Not Just Capture; Processing Fee Withheld as `null`, Never `0`
**Status:** Accepted (Founder decision)

**Context:** Sprint 8 (Transactions, `IMPLEMENTATION_PLAN.md`) requires a Ledger breakdown "computed from `LedgerLine` at read time" whose Definition of Done is that it "sums exactly to its `gross_amount`." Two real questions, checked by fact before writing any code, per `CLAUDE_RULES.md`'s "Ask Better Questions":

1. A Transaction can carry more than one `JournalEntry` over its life — `PAYMENT_CAPTURED` always, then optionally `TIP_ALLOCATED`, one-or-more `REFUND_ISSUED`, and up to two `CHARGEBACK` rows (`DATABASE.md`: "`Transaction → many JournalEntry`"). Does a correct breakdown require special-case handling for how ADR-023 spreads a refund's reversal across three accounts, or does it reduce to something simpler?
2. `UX_MAP.md`'s Transaction Details lists `Processing Fee` as its own field, and `MASTERPLAN.md` names "Processing Fees" and "Platform Fees" as two distinct concepts. Is Processing Fee — Stripe's own cut, distinct from the platform's — actually obtainable from this system's own `LedgerLine` data?

**Decision 1 — one aggregation, no entry-type special-casing:** for each of `RESTAURANT_REVENUE_PAYABLE`, `TIP_PAYABLE`, `PLATFORM_FEE_REVENUE`, and `REFUND_CONTRA`, the breakdown is `SUM(CREDIT) − SUM(DEBIT)` over every `LedgerLine` belonging to *any* `JournalEntry` under the Transaction — not filtered by `entry_type`. This isn't a special algorithm invented for this case: that subtraction, applied per account, **is** the definition of an account's balance in double-entry bookkeeping — the same operation already used everywhere else in this system (Wallet's own `recomputeBalance`, ADR-024, is the identical pattern one level down, scoped to `membershipId` instead of `transactionId`). No special handling is needed for `PAYMENT_CAPTURED`'s general, not-yet-attributed `TIP_PAYABLE` line (ADR-022): it and `TIP_ALLOCATED`'s own reversal of it cancel to zero by construction, leaving only the real, person-attributed credit in the sum, regardless of whether a filter on `membershipId` is applied at all.

Worked example, using this session's own live-verified numbers (`grossAmount=2000, tipAmount=500`, full refund): `netRestaurantRevenue = 1485 − 1485 = 0`; `netPlatformFee = 15 − 15 = 0`; `netTip = (500 + 500) − (500 + 500) = 0` (the general and person-attributed `TIP_PAYABLE` credits, minus `TIP_ALLOCATED`'s reversal and the refund's own debit); `refundedAmount = 2000 − 0 = 2000`. These four, plus `tax` (always `0`, see Decision 3), sum to exactly `2000` — the Transaction's own `grossAmount`, matching this Sprint's Definition of Done. This holds for any Transaction regardless of how many partial refunds or chargebacks it accumulates, since `PROCESSOR_CLEARING` is debited exactly once, at capture, for the full `grossAmount`, and never touched again by any later entry — every other account's net movement is, by the Ledger's own balance invariant, constrained to sum back to that one fixed debit.

**Decision 2 — Processing Fee stays a real, separate field, marked unavailable — never collapsed into Platform Fee:** confirmed against ADR-014's own Direct Charge + `fees_collector: "stripe"` configuration that Stripe deducts its own processing fee directly from the Restaurant's connected-account balance — a fact `payment_intent.succeeded`'s webhook payload never carries, and this system has no other writer for. The real figure exists only via a separate Stripe `balance_transaction` API call (with the `Stripe-Account` header), which is out of this Sprint's stated scope ("computed from `LedgerLine`"). `processingFee` is returned as `null`, **never `"0"`** — a literal zero would misstate a real, nonzero fee Stripe actually collects, which is a factual error `CLAUDE_RULES.md`'s Error Philosophy and Money Is Sacred principles both rule out. Collapsing it into `netPlatformFee` (the field that *is* available) was considered and rejected: `MASTERPLAN.md` treats Processing Fee and Platform Fee as two distinct concepts, and silently merging them would erase a distinction the product's own source-of-truth document considers meaningful.

**Decision 3 — `tax` stays `"0"`, for a different reason than Processing Fee:** `TAX_PAYABLE` exists in the chart of accounts (`schema.prisma`) but no code path writes to it yet — the same "schema ready, not yet used" state as Pool/Shift tip allocation strategies (ADR-007). Unlike Processing Fee, this is a gap in *our own* unbuilt logic, not an external system's data we can't reach — `0` is honest here (nothing has ever been charged as tax), where it would be dishonest for Processing Fee (Stripe genuinely charges something, we just can't see the number).

**Consequences:** `API_Contract.md`'s Transaction Details response shape documents all of `netRestaurantRevenue`/`netTip`/`netPlatformFee`/`tax`/`processingFee`/`refundedAmount`, with the `null`-not-`0` rule stated explicitly. `UX_MAP.md`'s Transaction Details section gains the same explanation, so the frontend renders `processingFee: null` as "—", never a false "€0.00". CSV export (`GET /transactions/export`) omits `processingFee` entirely — no CSV convention distinguishes "unavailable" from "zero" the way JSON `null` does.

---

## ADR-026 — Dashboard: Bill-Only "Today's Revenue," Restaurant-Timezone Day Boundaries, Ratio-of-Sums Average Tip, Net-Per-Membership Top Staff
**Status:** Accepted (Founder decision)

**Context:** Sprint 9 (Dashboard, `IMPLEMENTATION_PLAN.md`) lists six figures — Today's Revenue, Today's Tips, Revenue Chart, Recent Payments, Top Staff, Average Tip — with a DoD that they "match a manual sum over `LedgerLine`," but names no unit or formula for three of them. Three real questions, checked by fact before writing any code, per `CLAUDE_RULES.md`'s "Ask Better Questions": whether "Average Tip" is a percentage or an absolute amount (`IMPLEMENTATION_PLAN.md` says "Average Tip" with no unit; `UX_MAP.md`'s own Dashboard Purpose section asks "Average tip percentage?"); what period and granularity "Revenue Chart" covers (named nowhere); and what metric and window rank "Top Staff." Founder resolved all three directly.

**Decision 1 — "Today's Revenue" is bill-only sales, deliberately NOT the same quantity as ADR-025's `netRestaurantRevenue`:** computed as `net(RESTAURANT_REVENUE_PAYABLE) + net(PLATFORM_FEE_REVENUE)`, scoped to the Restaurant and to today. This is provably `SUM(billAmount)` net of refunds: `PAYMENT_CAPTURED` always credits exactly these two accounts with `billAmount`'s own split (`restaurantRevenue = billAmount - feeAmount`, ADR-021), and ADR-023's proportional refund reversal debits the identical two accounts for exactly the bill's own share of any refund — so their sum tracks `billAmount` exactly, before and after any refund, the same way ADR-025 already proved `PROCESSOR_CLEARING`'s single fixed debit constrains every other account's net movement. This is a different figure from `netRestaurantRevenue` (ADR-025's Transaction Details field, which nets out the platform fee — the restaurant's own take-home) on purpose: "how much business did we do today" is what an owner means by Dashboard revenue, the classic gross-sales sense, not "what's left after the platform's own cut." The Founder's own instruction to compute Average Tip as `SUM(tipAmount)/SUM(billAmount)` while reusing the already-computed Today's Revenue/Today's Tips sums only reconciles if "Today's Revenue" means `billAmount`, not `netRestaurantRevenue` — the two are literally different numbers once a nonzero platform fee exists. Resolved this way rather than asked again, since it's a derivation from already-agreed formulas, not a fresh business question; stated here explicitly so it can be corrected if this reading of intent is wrong.

**Decision 2 — day boundaries in the Restaurant's own timezone, not UTC:** `Restaurant.timezone` exists in the schema for exactly this; a naive UTC "today" would misclassify a Vilnius restaurant's own late-evening sales as "tomorrow" for hours. `apps/backend/src/common/timezone-day.util.ts` (`getLocalDayWindow`) computes this dependency-free via `Intl.DateTimeFormat`, not a new npm dependency — unit-tested directly, including a negative-offset timezone (America/Los_Angeles) and a month-boundary crossing, not just Vilnius's own positive offset. Known, accepted MVP-scale limitation, documented in the util's own doc comment: on the two days a year a timezone's DST offset changes, a window boundary can be off by the DST delta (typically one hour) specifically on those two days — every other day is exact. Revisit only if this ever shows up in practice (ADR-012 confines launch to one timezone for now).

**Decision 3 — "today" is a `LedgerLine.createdAt` window, not a `Transaction.createdAt` one — a refund posted today against an older sale reduces TODAY's totals, not the original sale's day:** deliberate, not a bug. Each day's own already-posted `LedgerLine` activity stays fixed once that day has passed (ADR-002's immutable-ledger philosophy applied per-day); a refund's own `LedgerLine` rows are dated when the refund actually posts, so today's dashboard correctly reflects today's real net Ledger activity, including refund activity against old sales — never retroactively rewriting a prior day's already-shown figures. Live-verified and unit-tested: a payment backdated to yesterday contributes nothing to today's revenue; a same-day refund against a payment from a prior day makes today's revenue negative, correctly.

**Decision 4 — Average Tip is the ratio of the two sums, not the average of each transaction's own tip%:** `averageTipBasisPoints = (todayTips * 10_000) / todayRevenue`, reusing the two already-computed sums rather than a separate per-transaction pass — the Founder's own explicit correction, and the financially correct reading: a €1 tip on a €2 coffee should not pull the average toward 50% as heavily as a €1 tip on a €200 dinner bill would under equal-weight-per-transaction averaging. Returned as a basis-points string (ADR-021's own vocabulary for percentage-as-integer, never a float), `null` — never `"0"` — when today's revenue is exactly zero: there is no meaningful ratio yet, and `"0"` would misrepresent "no data" as "a real 0% tip rate" (ADR-025's `processingFee: null` precedent, applied to a different field).

**Decision 5 — Revenue Chart: 7 local calendar days including today, oldest first, same bill-only definition as the single Today's Revenue figure, one aggregation per day:** small, fixed N; no `date_trunc` raw SQL needed at this scale — same "explicit over implicit, O(n) is fine here" reasoning as `WalletProjectionService`'s full recompute (ADR-024).

**Decision 6 — Top Staff ranks by today's net `TIP_PAYABLE` per `membershipId`, via `SUM(CREDIT) - SUM(DEBIT)`, never a naive sum of `TIP_ALLOCATED` credits alone:** the Founder's own explicit instruction, citing ADR-023 by name — a naive implementation that only summed credit lines would overstate a waiter's collected tips the moment a same-day refund reverses one, exactly the bug class ADR-023 fixed at the Transaction level, now avoided here from the start rather than discovered live. Live-verified and unit-tested: a tip-bearing payment refunded the same day nets to exactly zero for that Membership, not the pre-refund tip amount. A refund today against an older tip-bearing sale can make a Membership's net lower or negative for today — correct, not a bug, same day-boundary reasoning as Decision 3; ordinary "top" ordering handles it without a special case.

**Known limitation, not silently worked around:** `User` has no display-name field anywhere in the schema (checked directly — `id`, `email`, `password_hash`, `email_verified`, `two_factor_enabled`, `locale`, `last_login`, `status`, timestamps; no `firstName`/`lastName`/`displayName`). Top Staff surfaces `User.email` as the only available identifier. Out of this Sprint's own scope to add a name field; flagged here rather than invented.

**Decision 7 — `GET /dashboard` requires `restaurantId` explicitly, unlike Transaction List's optional one:** a Dashboard is always exactly one Restaurant's view (`UX_MAP.md`: an org-wide Owner lands on the Restaurants list, never a single combined Dashboard), and a restaurant-scoped Manager can hold Memberships at more than one Restaurant — a bare `GET /dashboard` would be ambiguous about which one is meant for that caller. Gated by the already-seeded `reports.view` permission (Owner/Administrator/Manager, not Waiter) at two independent layers — `PermissionsGuard` globally, plus a resource-scoped check that the specific reachable Membership itself carries the permission — the same two-layer shape `RestaurantService.assertPermission`'s own doc comment already establishes. Matches `UX_MAP.md` directly: the Waiter Portal's own navigation has no Dashboard item at all.

**Architecture note — reachability/permission predicates extracted to a shared util on their fourth near-identical occurrence:** `apps/backend/src/common/restaurant-reachability.util.ts` (`isRestaurantReachable`, `hasPermissionAtRestaurant`) — byte-identical logic to what `RestaurantService.getReachableRestaurantOrThrow`/`assertPermission` and `TransactionService.assertReachable` already each implement independently. Used by the new `DashboardService`; the three existing call sites are left untouched to avoid unrelated churn or regression risk in already-shipped, already-tested modules — consolidating them onto the shared util is a reasonable later cleanup, not part of this Sprint's own scope.

**Consequences:** `API_Contract.md`'s ANALYTICS > Dashboard section, previously a single bare `GET /dashboard` line, now documents the full request/response shape, the `restaurantId` requirement, and the `reports.view` gate. No `schema.prisma` change — Dashboard is pure read-time aggregation, nothing new to persist. Live-verified against a real running server: real Owner registration, real Restaurant creation, real Waiter invite-and-accept, a real `payment_intent.succeeded` webhook (`amount=2500, tipAmount=500`), confirming `todayRevenue="2000"`, `todayTips="500"`, `averageTipBasisPoints="2500"` (25%), the correct day bucketed in Revenue Chart, the real Transaction in Recent Payments, the real waiter's `tips="500"` in Top Staff, and a genuine `403 PERMISSION_DENIED` for the Waiter — plus an independent raw-SQL `SUM` over `ledger_line` matching the API's `todayRevenue` exactly, satisfying this Sprint's own DoD by direct measurement, not just by the service's own code path agreeing with itself.

---

## Superseded / Retired
- **CTO Operating Manual** — superseded by ADR-011; content to be merged into `CLAUDE_RULES.md`, then removed from the repository.
