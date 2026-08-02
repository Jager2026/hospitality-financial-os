---
title: API_SPECIFICATION
version: 2.1.0
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
GET /restaurants/{id} — includes `onboarding_status`, `charges_enabled`, `payouts_enabled`, `requirements_due` so the frontend can surface outstanding Stripe requirements (ADR-009).

## Update Restaurant
PATCH /restaurants/{id}

## Delete Restaurant
DELETE /restaurants/{id} — soft delete only.

---

# MEMBERSHIPS

Renamed from Employees (ADR-005). Represents one person's role at one restaurant, or one org-wide role.

## Invite Membership
POST /memberships — body includes `restaurant_id` (nullable — omit for an organization-wide role) and `role_id`.

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
POST /payments — **requires** `Idempotency-Key` header (ADR-004). Creates a payment session with the processor.

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
GET /settings — PATCH /settings

## Tip Configuration
PATCH /settings/tips
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

AUTH_INVALID · AUTH_EXPIRED · PAYMENT_FAILED · PAYMENT_DECLINED · INVALID_TIP · MEMBERSHIP_NOT_FOUND · RESTAURANT_NOT_FOUND · ORGANIZATION_NOT_FOUND · WALLET_NOT_FOUND · IDEMPOTENCY_KEY_CONFLICT · PERMISSION_DENIED · UNKNOWN_ERROR

Codes never change. Messages may be translated.

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
- `account.updated` → updates Restaurant `onboarding_status` / `charges_enabled` / `payouts_enabled` / `requirements_due`

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
