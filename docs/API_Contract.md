---
title: API_SPECIFICATION
version: 2.19.0
status: Active
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
supersedes: API_Contract v1.0 — see ARCHITECTURE_DECISIONS.md for the reasoning behind every change below
---

# API SPECIFICATION

> "An API is not code. It is a promise."

---

# How a route is written here

Each route line may be followed by a single **`Requires:`** line naming the Permission that route's `@RequirePermission` demands. **The convention is exhaustive, and that is the point:** every route the backend guards carries the line, so its absence means "this route needs authentication and no specific Permission" rather than "nobody wrote it down."

Before Sprint 14 the format had no place for this at all. The consequence was not a missing detail but an unanswerable question: of thirteen guarded routes, three happened to mention their Permission in prose and ten did not, and a frontend developer reading the contract could not tell that `GET /payments` needs `reports.view` or that every `/export` variant needs `data.export` rather than its sibling's `reports.view`. That distinction is deliberate (ADR-027) and was invisible here.

`repo-invariants.spec.ts` fails if a route carrying `@RequirePermission` does not state that Permission in this document — the convention is a check, not a habit.

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

# Field Naming — camelCase on the wire, snake_case in the database

**Every request body field, response field and query parameter in this document is `camelCase`.** `restaurantId`, `waiterMembershipId`, `displayName`, `cardPaymentsStatus`. That is what the code actually accepts and returns.

**The database is `snake_case`** — `restaurant_id`, `waiter_membership_id` — per `DATABASE.md`'s naming convention, mapped by Prisma's `@map`/`@@map`. The two conventions are deliberately different and the boundary is Prisma; nothing in between translates.

This is stated explicitly because the document got it wrong for a long time, in a way that is worth understanding rather than just fixing. **Every multi-word request field here was written in snake_case** — the database's convention, borrowed for the wire. It is a plausible slip: both conventions are real and live in the same project. Nothing caught it, because a contract document has nothing to disagree with — until the first real HTTP request. That request was made by the e2e harness, before any screen existed, and the API answered `displayName: Required`.

**Two names are correctly snake_case in this document and must stay that way:** Stripe's own field names (`application_fee_amount`, `balance_transaction`) and our database's own columns and tables (`token_hash`, `accepted_at`, `idempotency_keys`), which this document occasionally references directly. Those are quotations from another system's vocabulary, not our wire contract.

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
POST /auth/register — body: `email`, `password`, `displayName` (ADR-033, Sprint 13 — required; the name shown wherever this person needs to be identified by a human, e.g. the terminal's own staff-selection picker, Payment.md `MEMBERSHIPS`), `locale` (optional). Creates a User only. No Membership is created at registration: `Membership.organization_id` is required, and an Organization doesn't exist until this person creates their first Restaurant (see RESTAURANTS, `POST /restaurants`; DATABASE.md's Organization entity). A freshly registered User has zero Memberships, which DATABASE.md explicitly allows ("mid-invitation" is the same valid state). Previously said "+ Owner Membership" here, contradicting this document's own ORGANIZATIONS and RESTAURANTS sections — fixed to match the two places that already agreed. Also rejects (ADR-032, Sprint 13) a password found in a known breach corpus (`PASSWORD_BREACHED`) — checked only here and at Accept Invitation, never at Login.

`acceptedTermsVersion` (ADR-049, Sprint 14) — **required**. The revision of the platform terms the person was shown, taken from `GET /agreements/current` (below) rather than from a constant in the client. Compared against the server's own value: a mismatch is rejected with **409 `TERMS_VERSION_MISMATCH`** and nothing is created, never silently corrected — correcting it would record that someone accepted a document they were never shown. The User and its `agreement_acceptance` row are written in one transaction, with the request's IP and user-agent, so a User cannot exist without a record of what they agreed to. Note that registration therefore has **two distinct 409s**: this one, and the deliberately vague `VALIDATION_ERROR` for an email already in use — different codes precisely so a client can word them differently without either becoming an enumeration oracle.

## Login
POST /auth/login — returns Access Token, Refresh Token, User, Memberships.

## Refresh Token
POST /auth/refresh

## Logout
POST /auth/logout

## Current User
GET /auth/me

---

# AGREEMENTS

Added in Sprint 14 (ADR-049).

## Current Agreement Versions
GET /agreements/current — **public, no `Authorization` header**: a person must be able to read the terms before they have an account, and both values are constants carrying no personal data. Response: `platformTerms: { version }` and `stripeConnectedAccount: { version }`.

Both agreements are returned by one route rather than one route each — the Stripe-linked acceptance is collected at restaurant creation by a different screen, and a second endpoint would be a second place to keep in step for no gain.

The route exists so the version a client submits is the version the server served, not a constant compiled into a build that may predate the revision. It states which revision is current, not what it says: the text is served elsewhere, and today **both values are the placeholder `UNPUBLISHED-no-terms-document-exists-yet`** because neither document has been written. See ADR-049's pre-pilot gate.

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
Requires: `restaurant.create`

## Get Restaurants
GET /restaurants — scoped to every Restaurant the current user's Memberships grant access to. **Takes no query parameters.** This line previously claimed a `?organization_id=` filter to narrow to one chain; `RestaurantController`'s handler declares no `@Query` at all and `findAllForUser` accepts only the caller. The filter was never built — found during the Sprint 14 casing sweep, and worth separating from that sweep: a wrong field *name* fails loudly on the first request, while a documented parameter that does not exist is silently ignored by the server and looks to the caller like a filter that matched everything.

## Restaurant Details
GET /restaurants/{id} — includes `onboardingStatus`, `cardPaymentsStatus`, `payoutsStatus`, `requirementsDue` so the frontend can surface outstanding Stripe requirements (ADR-009, ADR-014 — Accounts v2 capability-status strings, not v1 booleans).

## Update Restaurant
PATCH /restaurants/{id}

## Delete Restaurant
DELETE /restaurants/{id} — **closes a venue** (ADR-054). Soft delete only: sets `deleted_at` and `status = INACTIVE`, and writes nothing else. Requires `restaurant.delete`.

The method and the permission keep their names — both are identifiers, not words a customer reads — but **the action is closing, not deleting**, and every user-facing surface must say so. Operations stop: eleven read sites filter `deleted_at IS NULL`, so a closed venue cannot be fetched, configured, staffed, invited into, or take another payment. **Reporting does not stop**: `GET /payments`, `GET /transactions`, their exports, and the wallet routes deliberately continue to return its history, because a payment taken before closing still happened and the ten-year accounting floor requires it to stay in the books of its own period.

**Webhooks for a closed venue are processed normally** — the capture that was in flight when the owner closed, and a chargeback months later, both still reach the Ledger. Refusing them would strand money Stripe has settled and our books never recorded, and `PaymentReconciliationService` compares exactly those two.

**Stripe is untouched.** The connected account belongs to the venue's owner (Direct charges, `dashboard: "full"` — ADR-014). Closing ends our routing of payments through it and does not close their account.

There is no reopen endpoint yet. It is planned as its own change; nothing here forecloses it.

## Restaurant Onboarding Link
POST /restaurants/{id}/onboarding-link — generates a fresh Stripe Account Link (ADR-014) for the restaurant's Connect account and returns `{ url }` for the frontend to redirect the owner to. Short-lived (Stripe expires these links quickly); callers must not cache the URL.

---

# ROLES

New resource (ADR-044, Sprint 14).

## Assignable Roles
GET /roles — **requires `membership.invite`.** Every Role a Restaurant may actually grant, as `id`, `name`, `description`. The data source for the Invite Employee screen (`UX_MAP.md`).
Requires: `membership.invite`

Built because `POST /memberships` has required a `roleId` since Sprint 4 and **nothing returned one** — a required input with nothing addressable behind it, the same shape ADR-039 named for a staff member’s Wallet.

**Excludes `platformOnly` Roles** — today that is `Administrator`, which holds every Permission and is ours to grant, never a Restaurant’s. **That exclusion is enforced on every write path, not only here:** `POST /memberships`, `PATCH /memberships/{id}` and `POST /memberships/invitations/accept` all refuse such a Role. Filtering only the list would leave the dropdown looking correct while a direct API call still granted it.

Refusals answer `Role not found`, not `forbidden`: to a Restaurant the Role does not exist, and confirming otherwise would invite someone to look for a way to it.

Gated on `membership.invite` rather than a permission of its own — the list exists to populate the invite screen, so the people who may invite are exactly the people who need it. Reference data, identical for every caller; no reachability scoping, because a Role is not owned by an Organization.

---

# MEMBERSHIPS

Renamed from Employees (ADR-005). Represents one person's role at one restaurant, or one org-wide role.

## Invite Membership
POST /memberships — body: `email`, `restaurantId` (nullable — omit for an organization-wide role), `roleId` (must be an assignable Role: a `platformOnly` one is refused with `Role not found`, ADR-044; see `GET /roles` for the list). Creates a `MembershipInvitation` (ADR-020), never a `Membership` directly — true even when `email` already belongs to an existing User: every invitation is explicitly accepted, uniformly, rather than a Membership appearing because someone else typed an email into a form. Response includes the raw invitation token exactly once — no email-delivery provider exists yet (undocumented, so not something this endpoint invents); the caller is responsible for relaying it until one is introduced with its own ADR.
Requires: `membership.invite`

## Accept Invitation
POST /memberships/invitations/accept — public, no `Authorization` header (the invitee may not have an account yet). Body: `email`, `token`, `password` and `displayName` (ADR-033, Sprint 13) — both required only if no `User` currently exists for `email` (ignored otherwise, since an existing User already has one). Looks up pending, non-expired `MembershipInvitation` rows by `email` and hash-verifies `token` against each candidate's `token_hash`, the same shape as a login password check (ADR-020) — never a lookup keyed on the token itself. On success: creates `User` (only if none exists for `email`) and `Membership` together, atomically, and sets `accepted_at`. Also rejects (ADR-032, Sprint 13) a password found in a known breach corpus (`PASSWORD_BREACHED`) whenever a new `User` is actually being created here.

## Membership List
GET /memberships — **requires authentication only, and that is a decision rather than an oversight** (Founder, ADR-043's review). Returns every Membership reachable by the caller: colleagues at the restaurants they work at.

Recorded explicitly because the absence of a permission decorator was, on two other routes, exactly an omission — so silence here would be indistinguishable from the same mistake. The reasoning is different: a Transaction holds the restaurant's revenue, fee and tax, which a waiter has no relationship to; **a colleague list is operational information the people on it already have.** They work the same shifts. Scoping stays reachability-based (ADR-005): a Membership at one restaurant does not reveal another restaurant's staff.

**Revisit if this response ever grows a field that is not already common knowledge on the floor** — anything compensation-adjacent, a home address, a contract date. The decision is about *what is returned*, not about the route.

## Membership Details
GET /memberships/{id}

## Update Membership
PATCH /memberships/{id}

## Disable Membership
PATCH /memberships/{id}/disable

## Restaurant Staff
GET /restaurants/{id}/staff — new, ADR-033, Sprint 13. Every `ACTIVE`, non-deleted Membership reachable at this Restaurant (same reachability rule as everywhere else, ADR-005), with no Role filter — "who actually served this table," not "who holds a specific Role." Returns `id`, `displayName`, `email`, `roleName` per entry. This is the terminal's own staff-selection picker's data source — the caller-side UI flow itself (three-dot menu → tap a name → one-button confirmation) has no frontend screen built yet (no screen in this codebase does); this endpoint and `POST /payments`'s new `waiterMembershipId` field are the backend half.

---

# PAYMENTS

## Create Payment
POST /payments — **requires** `Idempotency-Key` header (ADR-004). Body: `restaurantId`, `amount` (minor units, ADR-001, the full amount charged to the card — bill and tip combined), `tipAmount` (minor units, optional, defaults to 0, must not exceed `amount` — ADR-022), `waiterMembershipId` (ADR-033, Sprint 13 — the terminal's own "who actually served this table" selection; see `GET /restaurants/{id}/staff` above for the picker's data source). `currency` and `paymentMethod` are deliberately not client fields — `currency` always mirrors the Restaurant's own fixed Stripe-account currency (DATABASE.md, Restaurant Rules), and `paymentMethod` is server-set (`"card"`, the only method this MVP scope supports) rather than trusted from the client before Stripe has confirmed anything. Creates a Stripe PaymentIntent as a direct charge on the Restaurant's own connected account (ADR-014's Sprint 5 addendum) and a `PENDING` Payment row. `waiterMembershipId` is **required whenever `tip_amount > 0`** (rejected with `VALIDATION_ERROR` before Stripe is ever called if omitted) and validated as a real, `ACTIVE` Membership reachable at the Restaurant, no Role restriction — no longer captured automatically from the caller (ADR-022's original mechanism, revised); `null` when there's no tip, since there's nobody to attribute. `application_fee_amount` sent to Stripe is computed from `amount - tip_amount`, never the full `amount` — the platform fee excludes tips (ADR-021). Response: `id`, `restaurantId`, `amount`, `tipAmount`, `waiterMembershipId`, `currency`, `status`, `clientSecret` — the frontend confirms via Stripe.js using `clientSecret` (ADR-015); this endpoint never confirms the payment itself, and never writes a Ledger entry — that happens later, asynchronously, driven by the `payment_intent.succeeded` webhook (see Incoming Webhooks below).
Requires: `payments.manage`

## Payment Details
GET /payments/{id} — **requires `reports.view`**, and the permission is re-checked at the Restaurant this Payment belongs to, not merely held somewhere (PR #109). ADR-043 gave the LIST that threshold and this route was left with none: a zero-permission Waiter reached any payment at a restaurant they worked at, amount and tip included. Measured, not inferred.

**A waiter reading their own money is not what this refuses** — that is the Wallet and `GET /tips/me`, reached by ownership. A Payment is the restaurant's takings.

## Payment Status
GET /payments/{id}/status — **requires `reports.view`**, same rule and same reason as `GET /payments/{id}` above. Returning only a status string is not a weaker disclosure than returning the row: it still confirms that a specific payment exists at a restaurant the caller may not read.

## Payment History
GET /payments — pagination, sorting, filtering. **Requires `reports.view`** (ADR-043). It previously required no permission and scoped by reachability alone, so a Waiter saw the restaurant's full payment history — amounts and tips. A Payment is the restaurant's takings, not the waiter's: their own money is the Wallet and `GET /tips/me`, reached by ownership rather than by a claim on someone else's finances. Found by auditing for the shape of the transactions leak rather than by a test reaching it.
Requires: `reports.view`

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

Renamed and pluralized from Wallet (ADR-006) — a person may hold more than one, one per Membership. Read-only throughout — there is no `POST /wallets`; a Wallet is only ever created by the Outbox projection consumer, never by direct client request (ADR-024). Reachability-scoped, not permission-gated (ADR-024): the Wallet's own Membership, or a Membership reaching that Wallet's Restaurant (org-wide same-Organization, or restaurant-scoped same-Restaurant) — same rule as Payments/Tips (ADR-005). An org-wide Wallet holder (e.g. an Owner who personally took a payment) has no Restaurant to check reachability against, so only that Membership's own holder can reach it.

## My Wallets
GET /wallets — every Wallet the current user holds, each tagged with its Restaurant/Organization. The Waiter Portal aggregates these for display; the underlying balances stay separate per employer. Response: array of `{ id, membershipId, restaurantId, restaurantName, organizationId, availableBalance, pendingBalance, currency, status }` — `pendingBalance` is always `"0"` for MVP (ADR-024: no `Withdrawal` yet, nothing is cashable regardless of label).

## Wallet Details
GET /wallets/{id} — same shape as one entry above.

## Wallet Transactions
GET /wallets/{id}/transactions — Ledger-derived history for this Wallet only, newest first. Response: array of `{ ledgerLineId, account, direction, amount, currency, restaurantId, transactionId, entryType, createdAt }`.

## Staff Member's Wallet
GET /memberships/{id}/wallet — new, ADR-039, Sprint 13. The Wallet backing one Membership, addressed through the Membership that owns it. This is how the Employee Details screen (`UX_MAP.md`) reaches a staff member's Wallet: `GET /wallets` returns only the caller's *own*, so the id `GET /wallets/{id}` needs was previously unobtainable by the Manager or Owner that ADR-024 had always permitted to view it — a permission with no addressable resource behind it. Same reachability rule as `GET /wallets/{id}`, reusing the identical check rather than restating it: the Wallet's own holder always, plus anyone reaching that Wallet's Restaurant (org-wide in the same Organization, or scoped to that exact Restaurant). An org-wide holder's own Wallet remains reachable only by themselves. **A Membership with no Wallet yet returns the same `WALLET_NOT_FOUND` as an unreachable one, deliberately** — distinguishable responses would make this an existence oracle for Memberships in other Organizations. Deliberately *not* implemented as `GET /wallets?membershipId=`: that would silently change what an existing route exposes without changing its name (ADR-039).

## Withdrawal Request
POST /wallets/{id}/withdrawals — future (IMPLEMENTATION_PLAN.md Sprint 7: "Future Withdrawals Placeholder"). Own-wallet-only, even though `GET /wallets/{id}` is reachable more widely — `PERMISSION_DENIED` for a Manager or Owner who can view but doesn't hold the Wallet, `WITHDRAWAL_NOT_AVAILABLE` (501) for the Wallet's own holder, so the response always means "not built yet," never "not yours."

---

# TRANSACTIONS

## Transaction List
GET /transactions — **requires `reports.view`** (ADR-043; it previously required no permission at all, which was an omission — the Dashboard, Analytics and this data’s own CSV export all require one, and different formats of one question must not have different thresholds). Scoped to the Restaurants reached by a Membership that CARRIES that permission, not by any Membership at all. Reachability-scoped the same way `GET /payments` already is (ADR-005): every Restaurant the caller's Memberships reach. Filters: `restaurantId`, `status` (`COMPLETED`/`PARTIALLY_REFUNDED`/`REFUNDED`/`DISPUTED`), `membership` (a Waiter's own Transactions, via `Payment.waiter_membership_id` — `GET /transactions?membership=123`, already named in Filtering below). Paginated (`page`/`limit`, same shape as every other list endpoint). Sort fixed at `created_at desc` for MVP, matching Payment History's own precedent.
Requires: `reports.view`

Response: `{ data: [{ id, restaurantId, paymentId, grossAmount, currency, tip, status, createdAt }], meta: { page, limit, total, pages } }`.

- `tip` — `net(TIP_PAYABLE)` for that Transaction, the **same definition** as Transaction Details' `netTip`, so the card and the detail screen can never show two different tips for one Transaction. Net of refund and chargeback activity, not the capture-time figure. `UX_MAP.md`'s Transaction Card promises Amount and Tip; until now the list returned only the amount, and unlike the card's missing Staff Member that gap was recorded nowhere (`UX_API_RECONCILIATION.md`, section B). Computed for a whole page in one aggregation, not per row.

## Transaction Details
GET /transactions/{id} — **requires `reports.view`**, re-checked at the Transaction's own Restaurant (PR #109); the list and the export already carried it and this route did not. Includes a Ledger breakdown, computed at read time from **every** `JournalEntry`/`LedgerLine` row this Transaction has — not just the original `PAYMENT_CAPTURED` entry — so a refunded or disputed Transaction shows its current net effect, not a snapshot frozen at capture (`UX_MAP.md`: "an owner is never left wondering why a number changed"). Not stored directly on Transaction (ADR-002).

Response: `{ id, restaurantId, paymentId, grossAmount, currency, status, createdAt, netRestaurantRevenue, netTip, netPlatformFee, tax, processingFee, refundedAmount, refunds, chargebacks }`.

- `netRestaurantRevenue`, `netTip`, `netPlatformFee`, `refundedAmount` — each the sum of `CREDIT` minus the sum of `DEBIT` `LedgerLine` amounts for that account (`RESTAURANT_REVENUE_PAYABLE`/`TIP_PAYABLE`/`PLATFORM_FEE_REVENUE`/`REFUND_CONTRA`), across every `JournalEntry` under this Transaction — that subtraction, applied per account, **is** the definition of an account balance in double-entry bookkeeping; no special handling is needed for the general, not-yet-attributed `TIP_PAYABLE` line `PAYMENT_CAPTURED` posts (ADR-022) — it and `TIP_ALLOCATED`'s own reversal of it cancel exactly, by construction. `refundedAmount` aggregates both Refund- and Chargeback-driven activity, since both post to `REFUND_CONTRA` (ADR-008/ADR-016). These four, plus `tax`, always sum to exactly `grossAmount` — this Sprint's own Definition of Done, and true for any Transaction regardless of how many partial refunds or chargebacks it has, since `PROCESSOR_CLEARING` is debited exactly once, at capture, for the full `grossAmount`, and never touched again.
- `tax` — always `"0"` for MVP. `TAX_PAYABLE` exists in the chart of accounts (`schema.prisma`) but no code path writes to it yet — the same "schema ready, not yet used" state as Pool/Shift tip allocation strategies (ADR-007).
- `processingFee` — always `null` for MVP, **never `"0"`** (a literal zero would misstate a real, nonzero fee Stripe actually collects). Not the same gap as `tax`: this isn't unbuilt logic, it's a fact-checked Stripe limitation. Under ADR-014's Direct Charge + `fees_collector: "stripe"` configuration, Stripe deducts its own processing fee directly from the Restaurant's own connected-account balance — a fact our `payment_intent.succeeded` webhook payload never carries. The real figure exists only via a separate Stripe `balance_transaction` API call (with the `Stripe-Account` header), which is out of this Sprint's scope ("breakdown computed from `LedgerLine`," `IMPLEMENTATION_PLAN.md`). `MASTERPLAN.md` names Processing Fee and Platform Fee as two distinct concepts — kept as two distinct fields here, not collapsed into the one (`netPlatformFee`) that is actually available.
- `refunds` / `chargebacks` — this Transaction's own `Refund`/`Chargeback` rows (see below), so the client never has to make a second round trip to answer "why did this number change."

## Export
GET /transactions/export — CSV for MVP (Excel, PDF: future). Same filters as Transaction List, no pagination — every matching row. Columns: `id, restaurantId, grossAmount, currency, status, createdAt, netRestaurantRevenue, netTip, netPlatformFee, tax, refundedAmount` — `processingFee` omitted from the export entirely (same reasoning as Transaction Details: `null` has no honest CSV representation that isn't confusable with a real `0`).
Requires: `data.export`

---

# ANALYTICS

**Two vocabularies, on purpose (ADR-065).** The JSON endpoints below are **operational screens and count SHIFTS**: a range like `from=2026-09-01&to=2026-09-07` means the seven working days the venue calls by those names, so a shift opened on the 7th and closed at 02:00 on the 8th is included in full, after-midnight takings and all. The `/export` CSVs are **accounting output and stay CALENDAR**, because the accountant is bound by law to a calendar period — the same shift is split across two dated rows there. **Both come from the same LedgerLine rows, so the two can never disagree about the money, only about how it is grouped.**

## Dashboard
GET /dashboard?restaurantId={id} — `restaurantId` required (Sprint 9, ADR-026): a Dashboard is always exactly one Restaurant's view (an org-wide Owner lands on the Restaurants list instead, `UX_MAP.md`), and a restaurant-scoped Manager can hold Memberships at more than one Restaurant, so a bare call would be ambiguous about which one is meant. Requires `reports.view` (seeded, Owner/Administrator/Manager, not Waiter — the Waiter Portal's own navigation has no Dashboard item at all), checked at two layers: `PermissionsGuard` globally, then a resource-scoped check that the specific Membership reaching this Restaurant carries the permission (same shape as every other fine-grained permission check in this document).
Requires: `reports.view`

Every money figure is a live `SUM(CREDIT) - SUM(DEBIT)` aggregation over `LedgerLine`, scoped to the Restaurant and to "today" as a calendar day in the Restaurant's own `timezone` (ADR-026) — never a read of `Payment`/`Transaction` fields directly, and never UTC "today." The window is `LedgerLine.createdAt`-scoped, not `Transaction.createdAt`-scoped: a refund posted today against a payment from a prior day correctly reduces TODAY's totals, not the original sale's day (ADR-026, Decision 3) — each day's own already-posted Ledger activity stays fixed once that day has passed.

Response: `{ restaurantId, shift, shiftRevenue, shiftRevenueNote, shiftTips, averageTipBasisPoints, shiftTransactions, averageBill, revenueChart, recentPayments, topStaff }`.

**Every figure is scoped to a SHIFT, not a calendar day (ADR-065).** The fields were `today*` while this screen counted calendar days; they are `shift*` now because ADR-065 requires a screen to state which day it means, and a field called "today" on a shift-scoped number is exactly the ambiguity that rule removes. **A breaking rename, made deliberately while there is no frontend consumer.**

`shift` is the working day this summary is about — the open one, or the most recently closed when the venue has none open, so the screen is not blank at 06:00 before the first sale. `null` only for a venue that has never traded, in which case every figure is zero-shaped. It carries `{ id, businessDate, openedAt, closedAt, closeReason, closedAfterMidnight, afterMidnightRevenue }`.

- `closedAfterMidnight` / `afterMidnightRevenue` — **ADR-065's central pair: the number that explains why a Z-report and a bank statement differ, instead of hiding it.** `afterMidnightRevenue` is money that arrived between the midnight ending the shift's business date and its close; `"0"` — a real zero, not absent data — for a shift that closed before midnight. **Not a warning:** a shift closing at 01:30 is normal, and the copy must not imply otherwise.

**No Stripe account status here, deliberately (ADR-063).** The Dashboard banner (`UX_MAP.md`) needs `cardPaymentsStatus` / `payoutsStatus` / `requirementsDue`; it takes them from `GET /restaurants/{id}` in a second call. Every figure below is computed from our own Ledger and is exact as of the request; a capability status is a cached observation of Stripe's system, with its own freshness and its own failure mode. Folding them into one response would make the most-viewed screen in the product fail, or hang, on Stripe's availability.

- `shiftRevenue` — `net(RESTAURANT_REVENUE_PAYABLE) + net(PLATFORM_FEE_REVENUE)`, today: the gross amount customers paid for their bills. Deliberately NOT the same quantity as Transaction Details' `netRestaurantRevenue` (ADR-025), which nets the platform fee out — Revenue is what the customer paid; the platform fee is a separate expense against it, not a deduction from revenue itself before revenue is even reported (ADR-026, Decision 1). Both figures are correct; they answer different questions ("how much business did we do" vs. "what does the restaurant keep").
- `shiftRevenueNote` — always the fixed string `"Before platform fee deduction"` (ADR-026) — since `shiftRevenue` doesn't match `netRestaurantRevenue` shown elsewhere in the product, the difference must be explicit on screen wherever `shiftRevenue` is rendered, not left to documentation alone.
- `shiftTips` — `net(TIP_PAYABLE)`, today, unfiltered by `membershipId` — the general `PAYMENT_CAPTURED` credit and `TIP_ALLOCATED`'s own reversal of it cancel to zero by construction (ADR-022/025), same as everywhere else this pattern appears.
- `averageTipBasisPoints` — `(todayTips × 10000) / todayRevenue`, the ratio of the two sums above, never an average of individual transactions' own tip percentages (ADR-026, Decision 4 — the Founder's own explicit correction). A string of basis points (ADR-021's vocabulary — e.g. `"2500"` = 25.00%), `null` — never `"0"` — when `shiftRevenue` is exactly zero.
- `shiftTransactions` — a **count** of sales made today: one per `PAYMENT_CAPTURED` entry inside the local-day window, counted over `LedgerLine.created_at` like every money figure on this screen (ADR-026), never over `Transaction.created_at`. A refund posted today against an older sale moves `shiftRevenue` and does **not** move this — it is a count of sales, not of ledger activity. A plain number, not a minor-units string.
- `averageBill` — `todayRevenue / todayTransactions`, floored to minor units: the ratio of the sums, the same discipline as `averageTipBasisPoints` (ADR-026, Decision 4). **`null` — never `"0"` — when `shiftTransactions` is 0**: there is no divisor, and "no bills today" is not "a bill of zero" (ADR-025's null-not-0 precedent). Can be negative when today's refunds of older sales exceed today's takings; the screen renders that rather than clamping it (`UX_MAP.md`).
- `revenueChart` — the last **7 SHIFTS**, oldest first, each `{ date, shiftId, revenue }`, using the identical `shiftRevenue` definition for that shift. `date` is the shift's business date — its name, not a bucket: **two shifts on one business date appear as two points**, because they were two working days. Fewer than 7 points for a venue that has not traded that long; a working day that never happened is not a day with no revenue.
- `recentPayments` — the 10 most recent Transactions for this Restaurant, all-time (not "today"-scoped) — `{ id, grossAmount, currency, status, createdAt }`.
- `topStaff` — up to 5 Memberships, ranked by today's net `TIP_PAYABLE` (`SUM(CREDIT) - SUM(DEBIT)`, never a naive sum of `TIP_ALLOCATED` credits alone — ADR-026, Decision 6, avoiding ADR-023's own bug class from the start) — `{ membershipId, email, tips }`. `email` is the only identifier available: `User` has no display-name field anywhere in the schema (a known, flagged limitation, ADR-026).

## Revenue, Tips, Staff, Performance, Reports (Sprint 10, ADR-027)

Every route below requires `restaurantId`, `from`, `to` (plain `"YYYY-MM-DD"`, interpreted in the Restaurant's own `timezone` — never UTC, same as Dashboard's own day-boundary rule, ADR-026 Decision 2) — `from` must not be after `to`, and the range must not exceed 366 days (a deliberate MVP-scale cap, `analytics-query.schema.ts`). Every money figure is the same live `SUM(CREDIT) - SUM(DEBIT)` `LedgerLine` aggregation Dashboard already uses (`restaurant-ledger-window.util.ts`, reused unmodified, not reimplemented — ADR-027 Decision 1), generalized from Dashboard's fixed "today"/"last 7 days" windows to the caller's own date range.

Gated by `reports.view` (seeded, Owner/Administrator/Manager, not Waiter — same as Dashboard), checked at two layers: `PermissionsGuard` globally, then a resource-scoped check that the specific Membership reaching this Restaurant actually carries the permission. The five `/export` routes below require `data.export` instead, at both layers — a caller holding only `reports.view` can read every JSON route here but gets `403 PERMISSION_DENIED` from every export; a caller holding only `data.export` gets the reverse. Checked independently at the service layer, not by the export routes internally reusing the read routes' own permission check (ADR-027 Decision 4 — a real bug caught and fixed by self-review before this Sprint shipped).

### Revenue
GET /analytics/revenue?restaurantId={id}&from={date}&to={date}

Response: `{ restaurantId, from, to, total, totalNote, series }`. `total` is `net(RESTAURANT_REVENUE_PAYABLE) + net(PLATFORM_FEE_REVENUE)` across the whole range — the identical bill-only definition as Dashboard's `shiftRevenue` (ADR-026 Decision 1), not `netRestaurantRevenue`. `totalNote` is always `"Before platform fee deduction"`, same fixed caption as Dashboard's `shiftRevenueNote`. `series` is one `{ date, amount }` point per calendar day in the range, oldest first.

GET /analytics/revenue/export — same query, CSV. Columns: `date, amount`. No pagination — every day in the range.
Requires: `data.export`

### Tips
GET /analytics/tips?restaurantId={id}&from={date}&to={date}

Response: `{ restaurantId, from, to, total, series }`. `total` is `net(TIP_PAYABLE)` across the range, unfiltered by `membershipId` — same definition as Dashboard's `shiftTips`. `series` is one `{ date, amount }` point per day.

GET /analytics/tips/export — same query, CSV. Columns: `date, amount`.
Requires: `data.export`

### Staff
GET /analytics/staff?restaurantId={id}&from={date}&to={date}&page={n}&limit={n} — renamed from `/analytics/employees`. The full ranked list for the range, paginated (`page`/`limit`, default `1`/`20`, max `limit` 100) — unlike Dashboard's Top Staff, not capped to a fixed N.

Response: `{ restaurantId, from, to, data, meta }`. `data` is `{ membershipId, email, tips }[]`, ranked by net `TIP_PAYABLE` descending (`SUM(CREDIT) - SUM(DEBIT)`, never a naive sum of credits alone — same ADR-023 bug class Dashboard's own Top Staff already avoids). `meta` is `{ page, limit, total, pages }`, `total`/`pages` reflecting the full unpaginated ranked list.

GET /analytics/staff/export — same query (restaurantId/from/to only — export ignores pagination), CSV. Columns: `membershipId, email, tips`. Every ranked Membership, one row each.
Requires: `data.export`

### Performance
GET /analytics/performance?restaurantId={id}&from={date}&to={date} — trend/period-over-period comparison (`UX_MAP.md`'s "Growth" and "Time Analysis" made concrete as one thing, ADR-027 Decision 2 — not a fourth thing duplicating Staff).

Response: `{ restaurantId, currentPeriod, previousPeriod, changeBasisPoints }`. `currentPeriod`/`previousPeriod` are each `{ from, to, revenue, tips, transactionCount }`. `previousPeriod` is the immediately preceding period of the SAME length as `currentPeriod`, ending the day before `from` begins (e.g. a 31-day current period compares against the 31 days immediately before it, not a fixed "previous calendar month"). `changeBasisPoints` is `{ revenue, tips, transactionCount }`, each a basis-points string (ADR-021's vocabulary) or `null` — never a fabricated `"0"` — when the corresponding `previousPeriod` figure is exactly zero.

GET /analytics/performance/export — same query, CSV. Columns: `metric, currentPeriod, previousPeriod, changeBasisPoints`. Three rows: `revenue`, `tips`, `transactionCount`.
Requires: `data.export`

### Reports
GET /analytics/reports?restaurantId={id}&from={date}&to={date}&type={type} — a small, fixed set of named reports, not a report-builder (ADR-027 Decision 3, the same "flexibility on demand of the first real case" precedent as `TipAllocationStrategy`/ADR-007 and `PlatformFeePolicy`/ADR-021). `type` defaults to, and today only accepts, `"period-summary"` — a second report type is a second enum value and a second branch, not a redesign.

`period-summary` response: `{ restaurantId, from, to, type, revenue, revenueNote, tips, averageTipBasisPoints, transactionCount, topStaff }` — Revenue, Tips, Average Tip, transaction count, and Top Staff for the range, in one round trip. `revenue`/`revenueNote`/`tips`/`averageTipBasisPoints` reuse Dashboard's own definitions and ratio-of-sums formula (ADR-026 Decision 4) verbatim, computed over the whole range instead of just today. `topStaff` is up to 5 Memberships, same rank-and-cap shape as Dashboard's own Top Staff.

GET /analytics/reports/export — same query, CSV. Columns: `restaurantId, from, to, type, revenue, tips, averageTipBasisPoints, transactionCount` — flat scalar fields only; `topStaff` is not a CSV column (nested lists get their own export, same precedent as Transaction export omitting `refunds`/`chargebacks` — use `/analytics/staff/export` instead).
Requires: `data.export`

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
GET /restaurants/{id}/settings/tips — PATCH /restaurants/{id}/settings/tips (Sprint 6, ADR-022) — corrected to a restaurant-scoped path (real gap found building this: `/settings/tips` with no restaurant id has no way to know which Restaurant it configures, unlike every other resource-specific endpoint in this document; the fix is the same restaurant-scoping convention already used everywhere else, e.g. `/restaurants/{id}/onboarding-link`). Requires `tips.configure` (seeded, Owner/Administrator/Manager, not Waiter). Percentage presets shown to the customer at Tip Selection (UX_MAP.md), not a validation rule on `POST /payments`'s `tipAmount`: the terminal computes the actual minor-unit amount from whichever preset (or Custom) the customer picks, and the server only ever checks `tip_amount <= amount`.
```json
{ "presetTips": [10, 15, 20] }
```

---

# PROFILE

GET /profile — PATCH /profile

`GET /profile` returns the caller's own identity: everything the access token already carried (`id`, `email`, `locale`, `memberships`) **plus `displayName`**, read from the `User` row. Additive — no field an existing caller reads was removed. Until now the logged-in person was the only one who could not read their own name, while the Dashboard has returned other people's since ADR-033 (`UX_API_RECONCILIATION.md`, section B).

`PATCH /profile` updates `locale` and answers with the same identity shape, so a screen re-reading the response after saving does not lose the name it was showing.

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

**Not implemented anywhere.** No endpoint accepts `sort` or `order`; no DTO declares them. Kept as the shape a future sorting parameter should take, marked so nobody builds against it:

?sort=createdAt&order=desc

---

# Search

**Not implemented anywhere.** No endpoint accepts `search`. Same status as Sorting above — a convention recorded ahead of its first use, not a claim about today:

?search=John

---

# HTTP Status Codes

200 Success · 201 Created · 204 Deleted · 400 Validation Error · 401 Unauthorized · 403 Forbidden · 404 Not Found · 409 Conflict (includes idempotency-key fingerprint mismatch) · 422 Validation Failed · 429 Rate Limited · 500 Internal Error · 501 Not Implemented (a documented future capability with no working implementation yet — added for `POST /wallets/{id}/withdrawals`, Sprint 7, ADR-024, so it answers honestly instead of 404ing as if the route doesn't exist)

---

# Error Codes

AUTH_INVALID · AUTH_EXPIRED · PAYMENT_FAILED · PAYMENT_DECLINED · INVALID_TIP · MEMBERSHIP_NOT_FOUND · INVITATION_INVALID · PAYMENT_NOT_FOUND · RESTAURANT_NOT_FOUND · ORGANIZATION_NOT_FOUND · WALLET_NOT_FOUND · WITHDRAWAL_NOT_AVAILABLE · IDEMPOTENCY_KEY_CONFLICT · PERMISSION_DENIED · PASSWORD_BREACHED · TERMS_VERSION_MISMATCH · REGISTRATION_UNAVAILABLE · VALIDATION_ERROR · NOT_FOUND · UNKNOWN_ERROR

`PASSWORD_BREACHED` (ADR-032, Sprint 13): the submitted password appears in a known public breach corpus (HaveIBeenPwned k-anonymity check) — returned only from `POST /auth/register` and `POST /memberships/invitations/accept`'s new-user path, never from Login.

`TERMS_VERSION_MISMATCH` (ADR-049, Sprint 14): the submitted agreement version is not the one this server currently serves — returned from `POST /auth/register` with **409**. Its own code rather than a second `VALIDATION_ERROR` because registration's other 409 (an email already in use) must stay deliberately vague, while this one must say plainly that the terms changed and should be read again. A client cannot tell the two apart from the message, which is the one part of this envelope that may be translated.

`REGISTRATION_UNAVAILABLE` (ADR-055, Sprint 14): the platform terms have not been published, so no honest acceptance record can be written — returned from `POST /auth/register` with **503**, in production only. Not a 4xx: nothing about the request is wrong and the caller can do nothing about it. The gate lifts when `CURRENT_PLATFORM_TERMS_VERSION` stops being the placeholder, which is the same edit as publishing the document.

Codes never change. Messages may be translated. (`VALIDATION_ERROR`/`NOT_FOUND` were already live in `ErrorCode` and in active use — e.g. every Zod validation failure — but missing from this list; added here to close that gap, found while adding `PAYMENT_NOT_FOUND` for Sprint 5. `NOT_FOUND` is the generic fallback; prefer a dedicated `_NOT_FOUND` code per resource where one exists. `WITHDRAWAL_NOT_AVAILABLE` added for Sprint 7's Future Withdrawals Placeholder, ADR-024 — paired with HTTP 501, not 404 or 400.)

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
- `account.updated` → updates Restaurant `onboardingStatus` / `cardPaymentsStatus` / `payoutsStatus` / `requirementsDue` (ADR-009's revision — Accounts v2 capability-status strings, not v1 booleans)

---

# Outgoing Webhooks

Future — for third-party integrations, not required for MVP:
/payment.completed · /payment.failed · /tip.created · /wallet.updated · /membership.invited

---

# Rate Limiting

Global baseline: 100/min (ADR-010), applied to every route without its own override. Per-endpoint overrides, tuned by actual cost/abuse shape rather than uniformly (ADR-028, Sprint 11):

- `POST /auth/login` — 10/min (brute-force/credential-stuffing).
- `POST /memberships/invitations/accept` — 10/min (same cost/risk shape as login: a DB lookup by email plus a hash-compare per candidate).
- `POST /payments` — 20/min (every call creates a real Stripe PaymentIntent; the shape card-testing fraud targets).
- `POST /restaurants` and `POST /organizations/:organizationId/restaurants` — 5/min each (every call creates a real Stripe Connect account; the first carries no permission check at all by design).
- `POST /memberships` (invite) — 20/min (resource-exhaustion risk on `MembershipInvitation` row growth; becomes an email-spam risk once a real delivery provider exists, not yet).
- `POST /webhooks/stripe` — 500/min, raised above the baseline, not tightened: the signature is already verified before processing, and Stripe's webhook senders share a platform-wide IP pool, making the old 100/min baseline a cross-restaurant ceiling rather than a per-caller one.

Every override above is exercised by its own `*-throttle.integration.spec.ts` against the real Controller/Guard/Interceptor classes, not just documented here.

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
