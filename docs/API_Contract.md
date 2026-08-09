---
title: API_SPECIFICATION
version: 2.5.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
supersedes: API_Contract v1.0 — see ARCHITECTURE_DECISIONS.md for the reasoning behind every change below
---

# API SPECIFICATION

> "An API is not code. It is a promise."

---

# API Philosophy

The API represents business actions. Never implementation.

Bad: `/createRestaurant` — Good: `POST /restaurants`
Bad: `/getPayments` — Good: `GET /payments`

Resources. Not functions.

---

# Design Principles

RESTful · JSON Only · HTTPS Only · Stateless · Versioned · Predictable · Consistent · Idempotent where required.

---

# Base URL

`/api/v1`

Every future breaking release creates `/api/v2`. Never modify an existing version.

Two routes stay unprefixed, deliberately: `GET /health` (infra-facing — Docker healthcheck, load balancers, not part of the versioned client contract) and `POST /webhooks/stripe` (Sprint 5 — a fixed integration point Stripe itself calls, same reasoning as `/health`, not a client-facing REST resource that evolves under `/api/v1` → `/api/v2`).

---

# Authentication

Bearer JWT. Headers: `Authorization: Bearer {access_token}`, `Content-Type: application/json`.

---

# Standard Response

Success:
```json
{ "success": true, "data": {}, "meta": {} }
```
Error:
```json
{ "success": false, "error": { "code": "PAYMENT_FAILED", "message": "Payment could not be processed." } }
```

---

# AUTHENTICATION

## Register
POST /auth/register — creates a User only. No Membership is created at registration: `Membership.organization_id` is required, and an Organization doesn't exist until this person creates their first Restaurant (see RESTAURANTS, `POST /restaurants`; DATABASE.md's Organization entity). A freshly registered User has zero Memberships, which DATABASE.md explicitly allows ("mid-invitation" is the same valid state). Previously said "+ Owner Membership" here, contradicting this document's own ORGANIZATIONS and RESTAURANTS sections — fixed to match the two places that already agreed.

## Login
POST /auth/login — returns Access Token, Refresh Token, User, Memberships.

## Refresh Token
POST /auth/refresh

## Logout
POST /auth/logout

## Current User
GET /auth/me

---

# ORGANIZATIONS

New resource (ADR-005). Not exposed as a separate onboarding step for single-location businesses — created automatically the first time a Restaurant is created.

## My Organizations
GET /organizations — every Organization the current user holds a Membership in.

## Organization Details
GET /organizations/{id}

## Update Organization
PATCH /organizations/{id}

---

# RESTAURANTS

## Create Restaurant
POST /restaurants — creates a new Organization automatically if the user has none yet. This is the default path for a single-location business; the owner never sees "Organization" as a concept.

## Add Restaurant to Existing Organization
POST /organizations/{id}/restaurants — explicit path for adding a location to an existing chain. Distinguishes "I'm opening a new, independent restaurant" from "I'm adding a location to mine."

## Get Restaurants
GET /restaurants — scoped to every Restaurant the current user's Memberships grant access to. Supports `?organization_id=` to filter to one chain.

## Restaurant Details
GET /restaurants/{id} — includes `onboarding_status`, `card_payments_status`, `payouts_status`, `requirements_due` so the frontend can surface outstanding Stripe requirements (ADR-009, ADR-014 — Accounts v2 capability-status strings, not v1 booleans).

## Update Restaurant
PATCH /restaurants/{id}

## Delete Restaurant
DELETE /restaurants/{id} — soft delete only.

## Restaurant Onboarding Link
POST /restaurants/{id}/onboarding-link — generates a fresh Stripe Account Link (ADR-014) for the restaurant's Connect account and returns `{ url }` for the frontend to redirect the owner to. Short-lived (Stripe expires these links quickly); callers must not cache the URL.

---

# MEMBERSHIPS

Renamed from Employees (ADR-005). Represents one person's role at one restaurant, or one org-wide role.

## Invite Membership
POST /memberships — body: `email`, `restaurant_id` (nullable — omit for an organization-wide role), `role_id`. Creates a `MembershipInvitation` (ADR-020), never a `Membership` directly — true even when `email` already belongs to an existing User: every invitation is explicitly accepted, uniformly, rather than a Membership appearing because someone else typed an email into a form. Response includes the raw invitation token exactly once — no email-delivery provider exists yet (undocumented, so not something this endpoint invents); the caller is responsible for relaying it until one is introduced with its own ADR.

## Accept Invitation
POST /memberships/invitations/accept — public, no `Authorization` header (the invitee may not have an account yet). Body: `email`, `token`, `password` (required only if no `User` currently exists for `email` — ignored otherwise, since an existing User already has one). Looks up pending, non-expired `MembershipInvitation` rows by `email` and hash-verifies `token` against each candidate's `token_hash`, the same shape as a login password check (ADR-020) — never a lookup keyed on the token itself. On success: creates `User` (only if none exists for `email`) and `Membership` together, atomically, and sets `accepted_at`.

## Membership List
GET /memberships

## Membership Details
GET /memberships/{id}

## Update Membership
PATCH /memberships/{id}

## Disable Membership
PATCH /memberships/{id}/disable

---

# PAYMENTS

## Create Payment
POST /payments — **requires** `Idempotency-Key` header (ADR-004). Body: `restaurant_id`, `amount` (minor units, ADR-001, the full amount charged to the card — bill and tip combined), `tip_amount` (minor units, optional, defaults to 0, must not exceed `amount` — ADR-022). `currency` and `payment_method` are deliberately not client fields — `currency` always mirrors the Restaurant's own fixed Stripe-account currency (DATABASE.md, Restaurant Rules), and `payment_method` is server-set (`"card"`, the only method this MVP scope supports) rather than trusted from the client before Stripe has confirmed anything. Creates a Stripe PaymentIntent as a direct charge on the Restaurant's own connected account (ADR-014's Sprint 5 addendum) and a `PENDING` Payment row — `waiter_membership_id` is captured automatically from the authenticated caller's own Membership, never a client field (ADR-022). `application_fee_amount` sent to Stripe is computed from `amount - tip_amount`, never the full `amount` — the platform fee excludes tips (ADR-021). Response: `id`, `restaurant_id`, `amount`, `tip_amount`, `currency`, `status`, `client_secret` — the frontend confirms via Stripe.js using `client_secret` (ADR-015); this endpoint never confirms the payment itself, and never writes a Ledger entry — that happens later, asynchronously, driven by the `payment_intent.succeeded` webhook (see Incoming Webhooks below).

## Payment Details
GET /payments/{id}

## Payment Status
GET /payments/{id}/status

## Payment History
GET /payments — pagination, sorting, filtering.

---

# TIPS

There is no `POST /tips`. A Tip is written server-side as part of payment confirmation, then allocated into one or more `LedgerLine` credits (ADR-007) — never created by a direct client call. This closes a v1.0 gap where a public tip-creation endpoint could produce a record with no real, verified payment behind it.

## Tip Details
GET /tips/{id}

## My Tips
GET /tips/me — aggregated across every Membership the current user holds.

## Restaurant Tips
GET /restaurants/{id}/tips

---

# REFUNDS & CHARGEBACKS

New section (ADR-008). No self-service creation endpoint is required for MVP: refunds are initiated by staff through Stripe's own dashboard, and chargebacks originate from the card network. Both always reach the platform as a Stripe webhook (see Incoming Webhooks below), which is what actually writes the row and its compensating Ledger entry. Everything here is read-only.

## Transaction Refunds
GET /transactions/{id}/refunds

## Refund Details
GET /refunds/{id}

## Transaction Chargebacks
GET /transactions/{id}/chargebacks

## Chargeback Details
GET /chargebacks/{id}

---

# WALLETS

Renamed and pluralized from Wallet (ADR-006) — a person may hold more than one, one per Membership.

## My Wallets
GET /wallets — every Wallet the current user holds, each tagged with its Restaurant/Organization. The Waiter Portal aggregates these for display; the underlying balances stay separate per employer.

## Wallet Details
GET /wallets/{id}

## Wallet Transactions
GET /wallets/{id}/transactions — Ledger-derived history for this Wallet only.

## Withdrawal Request
POST /wallets/{id}/withdrawals — future.

---

# TRANSACTIONS

## Transaction List
GET /transactions

## Transaction Details
GET /transactions/{id} — includes a Ledger breakdown (restaurant revenue, tip, processing fee, platform fee, tax), computed from this Transaction's `JournalEntry` / `LedgerLine` rows at read time. Not stored directly on Transaction (ADR-002).

## Export
GET /transactions/export — CSV, Excel, future PDF.

---

# ANALYTICS

## Dashboard
GET /dashboard

## Revenue
GET /analytics/revenue

## Tips
GET /analytics/tips

## Staff
GET /analytics/staff — renamed from `/analytics/employees`; backed by Membership performance data.

## Reports
GET /analytics/reports

---

# CURRENCIES

New, small (ADR-001).

## List Supported Currencies
GET /currencies — returns the Currency reference table: code, exponent, name. Used to populate onboarding and currency-selection fields.

---

# SETTINGS

## Restaurant Settings
GET /settings — PATCH /settings — future; not built by Sprint 6 (Business Details, Tax Information, and the other Settings sections in UX_MAP.md belong to their own owning modules, not Tips).

## Tip Configuration
GET /restaurants/{id}/settings/tips — PATCH /restaurants/{id}/settings/tips (Sprint 6, ADR-022) — corrected to a restaurant-scoped path (real gap found building this: `/settings/tips` with no restaurant id has no way to know which Restaurant it configures, unlike every other resource-specific endpoint in this document; the fix is the same restaurant-scoping convention already used everywhere else, e.g. `/restaurants/{id}/onboarding-link`). Requires `tips.configure` (seeded, Owner/Administrator/Manager, not Waiter). Percentage presets shown to the customer at Tip Selection (UX_MAP.md), not a validation rule on `POST /payments`'s `tip_amount`: the terminal computes the actual minor-unit amount from whichever preset (or Custom) the customer picks, and the server only ever checks `tip_amount <= amount`.
```json
{ "presetTips": [10, 15, 20] }
```

---

# PROFILE

GET /profile — PATCH /profile

---

# FILES

Future. POST /uploads — GET /uploads/{id} — DELETE /uploads/{id}

---

# Pagination

```json
{ "page": 1, "limit": 20, "total": 400, "pages": 20 }
```

---

# Filtering

GET /payments?status=completed
GET /transactions?membership=123
GET /memberships?status=active

---

# Sorting

?sort=created_at&order=desc

---

# Search

?search=John

---

# HTTP Status Codes

200 Success · 201 Created · 204 Deleted · 400 Validation Error · 401 Unauthorized · 403 Forbidden · 404 Not Found · 409 Conflict (includes idempotency-key fingerprint mismatch) · 422 Validation Failed · 429 Rate Limited · 500 Internal Error

---

# Error Codes

AUTH_INVALID · AUTH_EXPIRED · PAYMENT_FAILED · PAYMENT_DECLINED · INVALID_TIP · MEMBERSHIP_NOT_FOUND · INVITATION_INVALID · PAYMENT_NOT_FOUND · RESTAURANT_NOT_FOUND · ORGANIZATION_NOT_FOUND · WALLET_NOT_FOUND · IDEMPOTENCY_KEY_CONFLICT · PERMISSION_DENIED · VALIDATION_ERROR · NOT_FOUND · UNKNOWN_ERROR

Codes never change. Messages may be translated. (`VALIDATION_ERROR`/`NOT_FOUND` were already live in `ErrorCode` and in active use — e.g. every Zod validation failure — but missing from this list; added here to close that gap, found while adding `PAYMENT_NOT_FOUND` for Sprint 5. `NOT_FOUND` is the generic fallback; prefer a dedicated `_NOT_FOUND` code per resource where one exists.)

---

# API Versioning

Never remove endpoints. Never silently change behavior. Always create v2 for breaking changes.

---

# Idempotency

Rewritten to match ADR-004 precisely — this is now a stateful contract, not just a header requirement.

Financial endpoints (Payments, and any future money-moving endpoint) require an `Idempotency-Key` header, backed by the `idempotency_keys` table (see DATABASE.md):

- Same key + same request fingerprint → returns the original stored response. No new side effect.
- Same key + **different** request fingerprint → `409 Conflict`. Request rejected, not silently processed.
- Keys expire after a fixed retention window.
- Incoming Stripe webhooks are deduplicated the same way, keyed by the provider's own event id — not a client-supplied key.

---

# Incoming Webhooks — Stripe

New section (was absent in v1.0; the old "Webhooks" section described a hypothetical outgoing system, not what Sprint 5 actually needs).

POST /webhooks/stripe

Verifies the Stripe signature before any processing. Every event is deduplicated via `IdempotencyKey`, keyed on the Stripe event id, before any Ledger write. Handles at minimum:

- `payment_intent.succeeded` → creates Transaction + JournalEntry + LedgerLines
- `charge.refunded` → creates Refund + compensating JournalEntry
- `charge.dispute.created` / `charge.dispute.closed` → creates/updates Chargeback + compensating JournalEntry
- `account.updated` → updates Restaurant `onboarding_status` / `card_payments_status` / `payouts_status` / `requirements_due` (ADR-009's revision — Accounts v2 capability-status strings, not v1 booleans)

---

# Outgoing Webhooks

Future — for third-party integrations, not required for MVP:
/payment.completed · /payment.failed · /tip.created · /wallet.updated · /membership.invited

---

# Rate Limiting

Authentication 10/min · Payments strict · Analytics moderate · Public low.

Active from Sprint 1 (ADR-010), not deferred to a later hardening pass. Limits configurable.

---

# Logging

Every request logs Request ID, Timestamp, User, IP, Response Time, Status. Sensitive data never logged.

---

# Security

HTTPS only · JWT · RBAC · Input Validation · Output Sanitization · SQL Injection Protection · XSS Protection · CSRF where applicable · Audit Logs. Webhook payloads are never processed without signature verification.

---

# API Principles

Predictable · Readable · Stable · Versioned · Secure · Documented · Fast · Business-Oriented. Never expose internal implementation details.

---

# Final Principle

Frontend should never need to guess. Backend should never surprise. The API is the contract that keeps both sides aligned.
