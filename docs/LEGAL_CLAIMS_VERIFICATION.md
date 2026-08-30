---
title: LEGAL_CLAIMS_VERIFICATION
version: 1.0.0
status: Active — verification report, no decisions
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# LEGAL CLAIMS VERIFICATION

> "A claim about code lives until its first execution, not until its first review."

Terms of Service and Privacy Policy v1.0 were written from handoff documents, not from execution. Each statement they make about how this system behaves is checked here against the code, with a file and line for every verdict.

**This report changes nothing.** No text is edited, no discrepancy is fixed, no code is touched. Where a claim does not hold, the wording that *would* hold is offered so the correction can be made where the texts live.

**Checked against `main` at `8ebf7b7`,** except claim 10 — see its entry.

---

# Summary

| # | claim | verdict |
|---|---|---|
| 1 | we collect no phone / address / DOB / national ID / card data | **REFUTED** |
| 2 | password stored only as a hash, unrecoverable | CONFIRMED |
| 3 | session token carries nothing about the person | CONFIRMED, with a caveat |
| 4 | retention periods of 10 years / 30 days / 90 days | **REFUTED** |
| 5 | every permission check is applied twice | **PARTLY REFUTED** |
| 6 | every data change is written to an append-only audit | PARTLY CONFIRMED |
| 7 | a database rule rejects an unbalanced entry | CONFIRMED |
| 8 | backups are encrypted | NOT VERIFIABLE IN CODE |
| 9 | financial rows point at a Membership, never a person | CONFIRMED, with a caveat |
| 10 | emptying erases email, name, password; blocks the account | CONFIRMED — **not on `main`** |
| 11 | funds never pass through an account we control | CONFIRMED, needs precision |
| 12 | the 100 bp fee is never charged on tips | CONFIRMED |
| 13 | closing a venue preserves financial history | CONFIRMED |

**Two claims must not ship as written: 1 and 4.** Claim 4 is the more serious of the two — it promises deletion that does not occur.

---

# REFUTED

## 1. "We do not collect phone number, home address, date of birth, national identifier or card data — none of these exist anywhere in our system"

**Two of the five do exist**, and they are required columns, not optional ones.

- `Restaurant.phone` — `apps/backend/prisma/schema.prisma:189`, `String`, **not nullable**
- `Restaurant.address` — `schema.prisma:194`, `String`, **not nullable**

Alongside them, on the same model: `legalName` (:185), `companyNumber` (:186), `vatNumber` (:187), `email` (:188).

**Why this matters rather than being a technicality.** `PERSONAL_DATA_MAP.md` §1 already records it: for a Lithuanian sole trader (*individuali veikla*) the legal name is the person's own name, and the address is frequently a home address. Nothing in the schema records which case a given Restaurant is — the distinction exists in Lithuanian law and not in our data. A privacy policy that says these fields do not exist is wrong precisely for the customers most likely to read it carefully.

**Correctly refuted for the other three.** Searched across the entire schema, not just `User`: there is no date of birth, no personal code, no passport field, no card number, no IBAN. `Restaurant.cardPaymentsStatus` (`schema.prisma:207`) is a Stripe *capability status* string (`"active"`, `"restricted"`), not card data — the name is the only thing card-shaped about it.

**Wording that would be true:**

> We do not collect dates of birth, national identifiers, or payment card details — none of these exist anywhere in our system; card data is handled entirely by Stripe and never reaches us. We do collect business contact details for each venue — its legal name, registration and VAT numbers, email, phone and address. Where a venue is operated by a sole trader, some of those details may be that individual's own.

---

## 4. "We retain data for 10 years / 30 days / 90 days"

**No mechanism applies any retention period. Nothing in this system is ever deleted on a schedule.**

Established by searching the whole backend for deletion of any kind:

- **`deleteMany` does not appear anywhere** in `apps/backend/src`.
- The only `.delete(` call is `webhooks/webhooks.service.ts:61` — a compensating removal of one `IdempotencyKey` when a webhook handler fails, so the event can be retried. Not age-based, and not retention.
- Two scheduled jobs exist and neither deletes anything: `outbox/outbox-poller.service.ts:54` (`@Interval`, publishes events) and `payment-reconciliation/payment-reconciliation.service.ts:37` (`@Interval`, compares pending payments against Stripe).
- `common/idempotency/idempotency.interceptor.ts:12` defines `KEY_TTL_MS = 24h`, which reads like retention and is not: it is the staleness comparison that decides whether a replayed key is still valid. The row itself stays.

`DATABASE.md:412` names purge-on-a-schedule as intended future work for `OutboxEvent`, `IdempotencyKey` and `MembershipInvitation`. **It was never built.**

**So the text as written promises an erasure that does not happen** — the one category of statement a privacy policy cannot carry, because it is checkable by anyone who asks us to prove it.

**Two honest ways forward, both available:**

1. **State the periods as policy, and say plainly that enforcement is manual today.** Accurate, and it commits us to doing it on request.
2. **Build the purge job before publishing.** It is not large, but it depends on a decision that is still open — `PERSONAL_DATA_MAP.md` §6 records that `AuditLog` needs *two* periods (a row recording a payment is transaction-connected and falls under the ten-year floor; a row recording a failed login is not), and nothing in the schema distinguishes them.

**Do not publish option 1's numbers without option 1's sentence.**

---

## 5. "Every permission check is applied twice — coarse in the Guard, fine in the service"

**True for eleven of the sixteen guarded routes. Not true for four, and the second check there is a different thing.**

`PermissionsGuard` (`auth/guards/permissions.guard.ts:71`) answers only *does this caller hold this permission on **any** Membership* — its own comment says so and marks narrowing as the services' job.

**Where the fine check is genuinely a permission check:**

- all 10 analytics routes and the dashboard → `getReachableReportingRestaurantOrThrow` (`common/restaurant-reachability.util.ts:172-186`), which re-checks the permission **at that restaurant**
- `restaurant`, `settings`, `membership` services → `assertPermission` / `hasPermissionAtRestaurant`

**Where it is not:**

- `POST /payments`, `GET /payments` → `payment/payment.service.ts:208-221` checks **reachability only** (`isRestaurantReachable`), never the permission at that restaurant
- `GET /transactions`, `GET /transactions/export` → `transaction/transaction.service.ts:266-278`, same shape
- `GET /roles` has no resource to narrow to, so there is nothing for a second check to do

**This is not a wording quibble.** Reachability and permission are exactly the two halves that `e2e/permission-scope.e2e.spec.ts` was written about: a caller who is Owner in Organization A and Waiter at a restaurant in Organization B passes the Guard on A's permission and passes reachability on B's membership, and nothing asks whether those are the same Membership. That spec proves the dashboard closes it. **Nothing proves the payment and transaction routes do.**

Flagged here, not fixed — PR 1 is a report. It deserves its own investigation.

**Wording that would be true:**

> Access is checked at two levels: a coarse check that you hold the required permission at all, and a second check at the specific venue that the data belongs to a venue you are entitled to see.

---

# CONFIRMED

## 2. Password stored only as a hash, unrecoverable

- `auth/password.util.ts:3` — bcrypt, `SALT_ROUNDS = 12`
- `auth/password.util.ts:8` — `bcrypt.hash`, the only place a password becomes a stored value
- `auth/auth.service.ts:86` — hashed **before** the `create` at `:91`; the plaintext never reaches Prisma

Every other occurrence of `password` in the backend is one of: DTO length validation (`dto/register.schema.ts:5`, `dto/login.schema.ts:5`), the breach check's SHA-1 prefix (`auth/hibp.util.ts:16`, k-anonymity — only the first five characters of the hash leave the process), or an error message. **No plaintext password is persisted or logged anywhere.**

## 3. The session token carries nothing about the person beyond identifying the session

**True of the token.** `auth/token.service.ts:98` signs `{ sub, jti, type: "access" }` — a user id, a token id, a type. The refresh token adds `familyId` (`:102`) for reuse detection. No email, no name, no role, no permission.

**Caveat the policy should not omit.** The browser stores more than the token. `apps/frontend/src/lib/auth/session.ts` persists `StoredSession` in `localStorage` under `hos.session`, and it contains `user: { id, email, locale }` plus the full list of memberships with role names and permissions. So *"the token tells a reader nothing about you"* is true; *"your browser holds nothing about you but a session id"* is not.

That file's own comment already flags the related open question — `localStorage` is readable by any script on the page, and an httpOnly cookie is the better end state.

## 6. Every data change is written to an append-only audit

**Append-only: confirmed, and more strictly than the claim.** `prisma.auditLog.create` at `common/audit/audit-metadata.ts:54` is the **only** `auditLog` operation in the entire backend — no update, no delete exists to be called. `repo-invariants.spec.ts` fails if any other file calls `prisma.auditLog.create` directly.

**"Every data change" is broader than what is true.** `common/interceptors/audit-log.interceptor.ts` is global but fires only on HTTP methods in `common/http/mutating-methods.ts` — `POST`, `PUT`, `PATCH`, `DELETE`. Changes made outside an HTTP request are not audited: the outbox poller's wallet projection, and the payment-reconciliation service's writes.

Append-only is also an application-layer property. Nothing at the database level prevents an `UPDATE` on `audit_log`.

**Wording that would be true:** *"Every change made through our API is recorded in an audit log that is only ever appended to."*

## 7. A database-level rule rejects an unbalanced entry

`apps/backend/prisma/sql/ledger_integrity.sql`:

- `:80-84` — `CREATE CONSTRAINT TRIGGER ledger_line_balanced ... DEFERRABLE INITIALLY DEFERRED`
- `:71-73` — `RAISE EXCEPTION 'JournalEntry % is unbalanced: debits=% credits=%'` when the two totals differ

Deferred deliberately, so a multi-line entry may be written line by line inside one transaction and is checked at commit. The rejection is Postgres's, not the application's: no code path can write an unbalanced entry, including one that bypasses our services entirely.

**Engineering note, not a legal defect.** The trigger sums the whole `JournalEntry` without grouping by `currency`, although `LedgerLine.currency` exists (`schema.prisma:533`). An entry mixing two currencies could balance in total while being unbalanced in each. Unreachable today — every entry derives from one Payment, and a Restaurant has one fixed currency — but the rule is narrower than "balanced per currency" and should not be described as the latter.

## 9. Financial rows point at a Membership, never at a person

`userId` appears on exactly three models in the entire schema: `Membership` (`schema.prisma:270`), `AuditLog` (`:681`), `AgreementAcceptance` (`:717`). It appears on **no** financial model — `Payment`, `LedgerLine`, `Wallet`, `Transaction` and `Tip` attribute to `Membership.id`, which carries no name, no email and no contact detail.

Defended by a test, not by convention: `repo-invariants.spec.ts` fails if a `userId` field appears on `Payment`, `LedgerLine`, `Wallet` or `Adjustment`, with a second assertion so the first cannot pass vacuously.

**Caveat a subject-access request will meet.** Two financial models reference a `User` as an **actor**: `Refund.requestedBy` / `Refund.approvedBy` (`:576-577`) and `Adjustment.createdBy` (`:629`). Those record *who performed an operation*, not *whose money it is* — the distinction `PERSONAL_DATA_MAP.md` §2 draws explicitly. They are still personal data and still have to be disclosed on request.

**Wording that would be true:** *"Financial records identify the working relationship a payment belongs to, never the individual directly. Where a refund or adjustment was performed by a member of staff, we record who performed it."*

## 10. Emptying erases email, name and password, and blocks the account

Confirmed against `apps/backend/src/user-redaction/redact-user.ts`: `email` → a per-row tombstone at a reserved `.invalid` domain, `displayName` → a fixed placeholder, `passwordHash` → a bcrypt hash of a discarded random value, plus `status: INACTIVE` and `deletedAt`. Login is refused on both `deletedAt` and `status`, independently. Proven by an integration test that logs the person in before the erasure and fails to afterwards.

**This code is not on `main`. It is in open PR #105.** Until that merges, a policy describing this mechanism describes something production does not have. **This is a publishing-order dependency, not a code defect.**

## 11. Funds never pass through an account we control

`stripe/stripe.service.ts:188-196` creates the PaymentIntent with `{ stripeAccount: params.stripeAccountId }` — a **Direct charge on the restaurant's own connected account** (ADR-014). The restaurant is merchant of record; the customer's money settles on their account and is never in ours.

**One precision the text needs.** `application_fee_amount` (`:193`) is our commission, and Stripe moves it to our platform account. That is our own revenue, not the customer's or the restaurant's money in transit — but a sentence saying *no funds ever touch an account we control* is, read literally, contradicted by it.

**Wording that would be true:** *"Customer payments settle directly into the venue's own Stripe account and never pass through any account we control. Our commission is transferred to us by Stripe from that settlement."*

## 12. The platform fee is never charged on tips

Verified in the Ledger write path, not in configuration:

- `webhooks/webhooks.service.ts:143` — `const billAmount = payment.amount - payment.tipAmount`
- `:144` — `splitPlatformFee(billAmount, basisPoints)`

The fee's base is the bill with the tip already subtracted. `payment/platform-fee.util.ts` derives `restaurantRevenue` by subtraction from that same base rather than by a second division, so the two parts sum to the base exactly. **A tip cannot enter the fee calculation, because it is removed before the calculation begins.**

## 13. Closing a venue preserves financial history

`restaurant/restaurant.service.ts:126-134` — `remove()` writes exactly two columns, `deletedAt` and `status: INACTIVE`. It touches no `Payment`, `Transaction`, `JournalEntry` or `LedgerLine`, and the Ledger is append-only by ADR-002 regardless.

Eight reporting routes deliberately continue to return a closed venue's data (payment and transaction lists, payment by id, wallet reads) — the same authorization-versus-reporting split ADR-051 draws. A payment taken before closure still happened, and the ten-year retention floor requires it to remain in the books of its own period.

---

# NOT VERIFIABLE IN CODE — the Founder must confirm these

**8. Backups are encrypted.** Backups are Railway's, not ours. There is no backup code in this repository to inspect. Confirm with Railway what is encrypted, at rest and in transit, and with what key management — then state only what they confirm in writing.

**TLS at the perimeter.** `main.ts:24` applies `helmet()`, which sets `Strict-Transport-Security` — an instruction to the browser, not proof that TLS terminates correctly. The certificate and termination are Railway's. Verifiable by the Founder from the live domains; not from this repository.

**Sub-processors.** Stripe and Railway are the two this code talks to. Whether the list is complete for legal purposes depends on tooling outside the repository (analytics, email, monitoring), which the Founder is better placed to enumerate.

**Anything about Stripe's own handling of the data it collects directly** — identity documents, beneficial owners, bank details. `PERSONAL_DATA_MAP.md` §5 records that these never pass through our system: we send only `contact_email`, `display_name` and `identity.country` at account creation. What Stripe does with the rest is governed by Stripe's terms, and `stripeAccountId` is only a pointer to a file we cannot read.

---

# What this report does not cover

- Whether the texts are legally sufficient. This checks only whether their statements about the system are true.
- The DPA. Art. 28(3)(g) was discussed separately; three candidate framings exist and none is chosen.
- `AuditLog`'s two retention periods (`PERSONAL_DATA_MAP.md` §6) — an open decision, and a prerequisite for claim 4's second option.
- Whether `ipAddress` / `userAgent` are erased with a person or retained as security records — the open decision the erasure mechanism deliberately refuses to settle.
