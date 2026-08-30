---
title: PERSONAL_DATA_MAP
version: 1.2.0
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
| `metadata` (`Json?`) | the column is still `Json?`, but the **write path is now closed** by the `AuditMetadata` type — see §3. Verified in production: it holds `{"waiterMembershipId": "…"}` on a Payment row |
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

**`AuditLog.metadata` was unbounded `Json` — now closed at the write path.** The column still accepts anything; Prisma cannot express otherwise. What changed is that every write goes through `writeAuditLog()`, whose `metadata` argument is a **closed TypeScript type** listing four machine identifiers and nothing else.

Adding a personal field is therefore a **compile error at the call site**, not something a reviewer has to notice. Falsified: putting `email` in a metadata literal fails typecheck with *"'email' does not exist in type 'AuditMetadata'"*.

**A type alone would have been advice**, since `prisma.auditLog.create` accepts any object handed to it directly — so `repo-invariants.spec.ts` fails if that call appears anywhere outside the helper. Falsified in that direction too. There were four writers before this, not one, which is why the answer is a shared typed writer rather than "only the interceptor may write".

**Deliberately not a runtime scan for personal-looking key names.** That needs a list of words that look personal, the list needs maintaining, and someone eventually edits it to make a build green — the rubber-stamp degradation `CLAUDE.md` names. A closed type needs no list.

The residual: widening `AuditMetadata` is still possible, and should be. It is now a deliberate edit to a file whose only purpose is that decision, rather than an object quietly growing at a call site.

---

# 4. What exists today

**Soft delete exists on four models: `Organization`, `Restaurant`, `User`, `Membership`.**

**Only one code path in the entire backend ever writes it** — `restaurant.service.ts:133`, which sets `deletedAt` and `status: "INACTIVE"` on a Restaurant. Verified by searching for every write of the field.

Therefore:

- **Nothing ever sets `deletedAt` on a `User` or a `Membership`.** The columns exist and are never populated.
- `PATCH /memberships/{id}/disable` sets `status: "INACTIVE"`, which is a different thing — the row remains active data, merely not usable for login.
- **There is no route that deletes a User.** The only `@Delete` in the codebase is `DELETE /restaurants/:id`.

**Soft delete on a Restaurant works — as an operational deactivation. It is not, and never was, a privacy mechanism.** The earlier wording here ("does not redact anything; a soft-deleted row is fully readable") was true and misleading in the same sentence, and it produced the reasonable but wrong conclusion that the flag hides nothing. Corrected, with the actual counts:

**Eleven Restaurant reads filter `deletedAt: null`**, including `restaurant-reachability.util.ts:178` — the single consolidated gate (ADR-047) through which every restaurant-scoped operation passes. A deleted Restaurant drops out of the owner's list (`restaurant.service.ts:106`), cannot be fetched (`:190`), cannot take a payment (`payment.service.ts:212`), be configured (`settings.service.ts:48`), have tips set (`tip.service.ts:123`), be invited into (`membership-invitation.service.ts:59`, `membership.controller.ts:147`), or list staff (`membership.service.ts:56`).

**Four reads deliberately do not filter, and the split is the same one ADR-051 drew.** `payment.service.ts:194` and `:159`, `transaction.service.ts:235`, and the wallet's name lookups reach a Restaurant through historical financial rows — a payment taken before the restaurant closed still happened. Reporting reads must not filter. One more, `restaurant.service.ts:158`, resolves a Stripe `account.updated` webhook by `stripeAccountId` and must find the row regardless; whether a closed restaurant should still absorb Stripe status updates is an open question, noted rather than answered.

**What it genuinely does not do is redact.** The row keeps `legalName`, `email`, `phone`, `address`, `companyNumber`, `vatNumber` — every field that is personal data when the Restaurant is a sole trader (§1). Deleting a Restaurant removes an operation, not a person.

**And none of it is tested.** There is no assertion anywhere in the suite that a deleted Restaurant disappears from any of those eleven paths. The behaviour above is established by reading the code, not by executing it — which is a weaker claim than this document should be making about an access-affecting flag, and is named here rather than glossed.

**The seven Membership reads have now been untangled, and doing so found a live authorization defect (ADR-051).** Four filtered, three did not — and the three splits cleanly in two:

| read | filters | verdict |
|---|---|---|
| `membership.service.ts` ×3, `payment.service.ts` | `deletedAt`, and `status` where relevant | correct |
| `jwt-auth.guard.ts`, `auth.service.ts` (`toAuthResult`) | **neither** | **the defect** — fixed by ADR-051 |
| `analytics.service.ts`, `dashboard.service.ts` | neither | **correct as-is**, see below |

The authorization path filtered nothing, which meant `PATCH /memberships/{id}/disable` set `status = "INACTIVE"` and the disabled person kept every permission. Proven by execution before it was fixed: a disabled Manager read the restaurant's dashboard with a token minted after the disable.

The two analytics reads attach names to already-ranked results. They are **historical**, and must not filter: a disabled waiter's tips still happened, and excluding them would misstate what a restaurant earned. **Authorization reads filter; reporting reads do not** — and applying one rule uniformly would have silently corrupted every report spanning a staffing change.

This is also the map's first finding to change behaviour rather than describe it, and it arrived from a question about erasure rather than about access. The two are the same question asked at different times: **what does the system do when a person is supposed to stop being present?**

**This was the single most consequential fact in this document, and it is now closed (ADR-052).** It read: *there is no mechanism, soft or hard, to remove or obscure a person's data; a GDPR erasure request has no code path at all.*

There is one now — `pnpm --filter backend run redact:user`. It empties the person (`email`, `displayName`, `passwordHash`, plus any `MembershipInvitation` carrying that address) and retains `Membership` and every financial row hanging from it, **because the ten-year floor in §6 requires them.** The nothing-else-changes half is what §2's boundary buys: the money was never pointed at the person.

Three things about it belong in this map rather than only in the ADR:

- **It is not reachable over HTTP, and that is enforced rather than described.** `repo-invariants.spec.ts` fails if any controller or module imports it. A subject-rights request at this scale is a manual, verified act; a route that empties a user is the most dangerous thing this codebase could expose.
- **It is dry-run by default.** A run without `--confirm` prints what would change and writes nothing — verified by running all four modes against a real row, not by reading the branch.
- **It is deliberately partial, and says so on every run.** Emptying `User` does not reach `ipAddress`/`userAgent` on that person's `AuditLog` and `AgreementAcceptance` rows. Whether those are retained as security records or erased with the person is the open decision in §6, and the script refuses to settle it by default: it prints the row count and the words *this erasure is partial* every time, so an incomplete erasure cannot be reported as a complete one by someone who did not know.

**What remains open is the policy question above, not the mechanism.**

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

# 6. Retention — determined, and the claim that was blocking it was wrong

**Founder determination, recorded as the Founder's, not as this document's own legal finding:**

- **Ten years** for data connected to transactions — the accounting retention floor.
- **The general contract rule** for everything else.

**The correction that made this answerable, recorded because the wrong version was asserted first and would otherwise have stood.** The waiter's employment-status classification was believed to block retention periods. **It does not.** It blocks GPM — the tip-tax estimate's rate, legal basis, and who the tax agent is (ADR-029 Decision 2, `THREAT_MODEL.md`). Retention is decided by accounting law, which does not wait on that classification. The two questions were being answered as one, and only one of them was actually open.

The practical consequence is the one that matters for the privacy policy: **retention periods can be written down now.** They were not blocked on anything.

**What this determination immediately implies, and it is not free:** `AuditLog` does not have one retention period. A row recording a payment is transaction-connected and falls under the ten-year floor; a row recording a failed login is not, and falls under the general rule. Nothing in the schema distinguishes them today — `AuditLog` has an `entity` column that could, but no code reads it for this purpose. **A single retention period applied to the whole table would be either unlawfully short for the first kind or needlessly long for the second.** Named here rather than assumed away; it needs a decision before any purge job is written.

**And retention cuts the other way too.** It is the reason the financial record survives an erasure request rather than a reason to be cautious about erasure: `Membership`, `LedgerLine`, `Payment`, `Wallet`, `Transaction`, `Refund` and `Adjustment` are retained **because the ten-year floor requires them**, not because deleting them would be awkward. §2's boundary is what makes that survivable — those rows attribute to `Membership.id`, never to a person.

---

# What this map does not answer

- Whether any given Restaurant is a sole trader. The schema does not record it, and the legal answer differs per row.
- Whether the CSV exports carry personal fields beyond the one identified. Sampled, not enumerated.
- Stripe's retention period for the identity data it holds on our connected accounts.
- Whether disabling a Membership should also revoke that person's refresh tokens (ADR-051 — a session question, deliberately separate from the access question it answers).

Each is listed rather than guessed, and none of them changes §2's boundary.
