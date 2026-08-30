---
title: PERSONAL_DATA_MAP
version: 1.1.0
status: Active — research, no decisions
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# PERSONAL DATA MAP

> "You cannot write a privacy policy before you know what the system collects."

Purpose: a factual inventory of every field that identifies a person, what it is linked to, and what would break if it were removed. **This document proposes nothing.** It exists because two obligations found in the Stripe research — our own terms of service, and a privacy policy referencing Stripe's — both depend on knowing the answer, and neither can be written from memory.

Every statement below was read out of `schema.prisma` and the service code, not recalled. Where something is *not* verified, it says so.

---

# 1. Fields that identify a person

## `User` — the person as a person

| field | why it identifies | notes |
|---|---|---|
| `email` | direct identifier, `@unique` | also the login credential |
| `displayName` | direct identifier — a real human name | added by ADR-032 so the staff picker could show a name instead of an email |
| `passwordHash` | not an identifier; personal data all the same | |
| `lastLogin` | behavioural — when this person was active | |
| `locale` | weak, but a preference attached to a person | |
| `id` | pseudonymous key | the join point for everything below |

## `Membership` — the person as a role at a place

| field | why it matters |
|---|---|
| `userId` | the link that makes a Membership a *person's* Membership |
| `hireDate` | employment data about an individual |
| `restaurantId`, `organizationId` | where that person works — location data by inference |
| `id` | **the key the entire financial side uses.** See §2 |

## `MembershipInvitation` — a person who may not exist in the system yet

| field | why it matters |
|---|---|
| `email` | an identifier for someone who has not consented to anything and may never accept |
| `invitedBy` | a `User.id` — who invited whom, retained after acceptance |
| `tokenHash`, `expiresAt`, `acceptedAt` | not identifiers; establish that a specific person acted at a specific time |

## `AuditLog` — the person as a trail

| field | why it matters |
|---|---|
| `userId` | nullable, **`ON DELETE SET NULL`** — see §3, this is the sharpest conflict in the map |
| `ipAddress` | personal data under GDPR in its own right, not merely metadata |
| `userAgent` | device and browser fingerprint surface |
| `metadata` (`Json?`) | **unbounded.** Whatever any interceptor chooses to put there. Verified in production: it currently holds `{"waiterMembershipId": "…"}` on a Payment row |
| `entityId` | often a Membership or User id |

## `Restaurant` — a business, except when it is a person

This is the row where "company data" and "personal data" are not separable by looking at the schema.

| field | when it is personal data |
|---|---|
| `legalName` | a Lithuanian sole trader (`individuali veikla`) trades under their own name |
| `email`, `phone` | the owner's own contact details in the single-person case |
| `address` | frequently a home address for a sole trader |
| `companyNumber`, `vatNumber` | tied to the individual rather than a separate legal entity |
| `stripeAccountId` | the key to Stripe's own file on that individual, including documents we never see |

**Nothing in the schema records which case a given Restaurant is.** The distinction exists in Lithuanian law and not in our data.

## The money side

| field | model | what it attributes |
|---|---|---|
| `waiterMembershipId` | `Payment` | which person a tip was for |
| `membershipId` | `LedgerLine` | which person a ledger line belongs to |
| `membershipId` | `Wallet` | `@unique` — the projection is keyed by person |

---

# 2. Where the boundary between "a person" and "a subject of a financial record" actually runs

**It runs at `Membership.id`, and the schema already puts it there.**

Every financial reference — `Payment.waiterMembershipId`, `LedgerLine.membershipId`, `Wallet.membershipId` — points at a **Membership**, never at a **User**. A Membership id carries no name, no email, no contact detail. It is already a pseudonym.

**So the structural answer is not "we could build this."** The boundary is already drawn, by the schema, and has been from the beginning: **financial references never go to `User`.** The person can be emptied while the financial subject survives, provided the Membership row itself is kept. The Ledger does not need to know who anyone is; it needs a stable, unique attribution key, and it already has one that is not an identifier.

**It is now defended by a check** (`repo-invariants.spec.ts`). A field named `userId` appearing on `Payment`, `LedgerLine`, `Wallet` or `Adjustment` fails the suite — and a second assertion fails if those models ever stop attributing to a Membership, so the first cannot pass vacuously.

Nothing stated this as a rule before. The schema simply happened to be built this way, which means **one migration would have made the conflict real without anyone noticing they had done something unusual** — the person adding `userId` to a ledger row would have had no reason to think twice.

The check names its own limit rather than overstating: it catches a field called `userId`, not a User relation given some other name. Its first draft tried to catch both by forbidding any mention of `User` in the model body, and immediately flagged `Adjustment.createdByUser` — an **actor** field, which this section explicitly allows. Recording *who requested a refund* is not the same as recording *whose money this is*, and a check that contradicts its own stated rule is worse than a narrower one.

**Three places break that separation by joining through to `User`**, and they are the only ones — found by searching for the join, not by recalling it:

- `analytics.service.ts:388` — `include: { user: { select: { email: true } } }`
- `dashboard.service.ts:198` — `include: { user: { select: { email: true, displayName: true } } }`
- `membership.service.ts:75` — `include: { user: true }` (the staff picker, ADR-033)

These are **presentation** joins: they exist to show a human a name. None of them computes a monetary value. That is the difference between a real conflict and an apparent one, and it decides most of §3.

---

# 3. What would break, and what only appears to

## Would not break

**The Ledger, Wallet, reconciliation, and every balance.** They reference `Membership.id` and never dereference `User`. Emptying `User.email` and `User.displayName` changes no monetary figure and no projection. `WalletProjectionService` recomputes from `LedgerLine.membershipId`; `PaymentReconciliationService` reads `Payment` alone.

**This is the apparent conflict in the map.** "Anonymising a person would corrupt the financial history" reads as obviously true and is false here, because the schema separated the two concerns before the question was asked.

## Would break, genuinely

**`AuditLog.userId` is `ON DELETE SET NULL`.** This was already found once, during the Sprint 13 production purge, and is the reason `User` rows were deliberately kept then. The consequence is precise: **deleting a User silently blanks every audit row that person ever produced** — the row survives, the actor does not. Erasure-by-deletion and auditability are in real conflict.

Erasure by *field emptying* — keeping the `User` row, clearing `email`/`displayName`/`passwordHash` — does not have this problem. The two are not equivalent, and the schema currently supports neither.

**Displayed names degrade to identifiers.** The staff picker (ADR-033), the dashboard's staff panel and the analytics staff report all show a name or an email. Emptying those fields turns those screens into lists of UUIDs. That is a genuine product cost, not a technical break — and it is a decision, not a consequence.

**Exports.** `GET /transactions/export` and the analytics CSVs are generated from Ledger data; the transaction export's columns are ids and amounts. The staff analytics export is the one that carries `email` (`analytics.service.ts:388`). Not verified field-by-field for every export — flagged rather than claimed.

## The one that is neither, yet

**`AuditLog.metadata` is unbounded `Json`.** Nothing constrains what future code writes there. Today it holds a Membership id. It is the single field in this schema where personal data can accumulate without anyone deciding that it should — no migration, no review, just an interceptor passing a larger object.

---

# 4. What exists today

**Soft delete exists on four models: `Organization`, `Restaurant`, `User`, `Membership`.**

**Only one code path in the entire backend ever writes it** — `restaurant.service.ts:133`, which sets `deletedAt` and `status: "INACTIVE"` on a Restaurant. Verified by searching for every write of the field.

Therefore:

- **Nothing ever sets `deletedAt` on a `User` or a `Membership`.** The columns exist and are never populated.
- `PATCH /memberships/{id}/disable` sets `status: "INACTIVE"`, which is a different thing — the row remains active data, merely not usable for login.
- **There is no route that deletes a User.** The only `@Delete` in the codebase is `DELETE /restaurants/:id`.

**And soft delete does not redact anything.** A soft-deleted row is fully readable; the effect is that 16 read sites filter `deletedAt: null`. Seven Membership reads exist in the backend and not all of them apply that filter — untangling which is future work, noted rather than resolved.

**So: today there is no mechanism, soft or hard, to remove or obscure a person's data. A GDPR erasure request has no code path at all.** Stated plainly because it is the single most consequential fact in this document.

---

# 5. Where personal data leaves the system

## Stripe — less than expected, and that is a real property

We send exactly three things at account creation (`stripe.service.ts:131`):

- `contact_email` — the Restaurant's `email`
- `display_name` — the Restaurant's `name`
- `identity.country`

**Everything else Stripe holds about the restaurant — beneficial owners, identity documents, bank details, date of birth — is collected by Stripe directly, in its own hosted onboarding, and never passes through our system.** We cannot leak what we never receive. The corollary is equally real: **our erasure cannot reach it either.** Stripe's own retention governs that file, and `stripeAccountId` is the pointer to it.

## The alerting webhook (Slack) — verified clean, with one caveat

`AlertService.sendAlert(message, context)` transmits **only `{ text: message }`**. The `context` argument is used for logging and **never reaches the wire** — verified at `alert.service.ts:33`.

All five alert messages in the codebase were read:

| source | content |
|---|---|
| `unhandled-error-alerter` | error name + route pattern |
| `redis-throttler.storage` ×2 | fixed strings about Redis being unreachable or recovered |
| `outbox-poller` | event id, event type, error message |
| `payment-reconciliation` ×3 | Payment id, and Stripe's reported status |
| `stripe.service` | credential error code |

**No personal data in any of them.** One caveat worth naming: the reconciliation message interpolates `err.message` from a failed Stripe call — vendor-controlled text, the one path by which unanticipated content could reach the channel.

## Railway logs

`pino` logs the request as `method, url, query, params, headers, remoteAddress, remotePort` — confirmed against a real production log line, not from configuration.

- **`ipAddress` does reach the logs**, via `remoteAddress` and the `x-forwarded-for` header.
- **Request bodies are not logged.** Passwords and email addresses therefore do not reach logs through bodies. The redact list previously also named `req.body.password`, `req.body.refreshToken` and `req.body.card` — **inert entries, since removed.** Not because inertness is harmless, but because the list would have been *dangerously incomplete* had it ever become live: it named three secrets and none of the personal data that actually travels in request bodies (`email`, `phone`, `displayName`, `address`). Whoever enabled body logging would have found a redaction list already present and concluded the question was settled. If bodies are ever logged, redaction gets designed then, against §1 of this document.
- `authorization` and `cookie` are redacted.
- There is no log drain (ADR-045), so log retention is whatever Railway's is — not something this project currently controls or has recorded.

---

# What this map does not answer

- Whether any given Restaurant is a sole trader. The schema does not record it, and the legal answer differs per row.
- Whether the CSV exports carry personal fields beyond the one identified. Sampled, not enumerated.
- Stripe's retention period for the identity data it holds on our connected accounts.
- Which of the seven Membership read paths apply the `deletedAt` filter.

Each is listed rather than guessed, and none of them changes §2's boundary.
