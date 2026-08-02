---
title: SPRINT_0_SCHEMA_AUDIT
version: 1.2.0
status: Closed — all open questions resolved, independently re-verified by Founder, Sprint 1 approved
classification: Internal
owner: Founder
technical_owner: AI Technical Co-Founder
scope: apps/backend/prisma/schema.prisma, translated from DATABASE.md v2.0.0
---

# SPRINT 0 — SCHEMA AUDIT

> Principal Database Architect pass over `schema.prisma`, before any migration ever touches a
> real database — per `CLAUDE_RULES.md`, "Never Trust Yourself."

No `prisma migrate` has been run. Node/pnpm are not available in this execution environment, so
`prisma validate` could not be run automatically either — run `pnpm install && pnpm run
prisma:validate` locally before trusting this schema compiles; the audit below is a manual,
line-by-line review, not a substitute for that command.

**Revision note (v1.1.0):** the Founder reviewed v1.0.0 and made two decisions, both applied to
`schema.prisma` and `ARCHITECTURE_DECISIONS.md` before this revision was written:

1. **ADR-017 direction reversed.** The original draft had Refund/Chargeback/Adjustment each own a
   unique `journal_entry_id` pointing at JournalEntry. The Founder caught a real correctness bug
   in that design: ADR-016 already describes a Chargeback producing *two* compensating
   JournalEntries over its lifetime (a provisional-loss entry, then a reversal if the dispute is
   later won) — a one-to-many relationship a unique FK on Chargeback cannot express. ADR-017 now
   has JournalEntry own three nullable FKs (`refund_id`, `chargeback_id`, `adjustment_id`),
   mirroring the existing `transaction_id` pattern. Status is now **Accepted**, not Proposed. See
   §7 below and the rewritten ADR-017 in `ARCHITECTURE_DECISIONS.md`.
2. **The deferred constraint trigger for debit=credit (§2) is approved** and added to Sprint 1's
   scope in `IMPLEMENTATION_PLAN.md`.

This left two of the original four open questions resolved and two still open at v1.1.0.

**Revision note (v1.2.0):** the Founder independently re-checked `schema.prisma` line-by-line
against `DATABASE.md` and confirmed no hidden issues beyond what this audit already surfaced —
external verification, not just self-review. Both remaining open questions are now closed:

3. **Payment mutability — resolved as ADR-018 (Accepted).** `Payment.status` is mutable,
   transitioning exactly once from `pending` to `succeeded` / `failed` / `canceled` / `declined`,
   with a real `updated_at`. "Immutable once created" applies to the payment's identity and
   economic facts (amount, restaurant_id, processor, processor_payment_id, currency,
   payment_method, idempotency_key), never to its outcome. `FAILED` and `DECLINED` are kept
   distinct because MASTERPLAN.md's Fraud Prevention treats repeated failures as a signal, and a
   processing timeout is a different signal than an issuer decline. `DATABASE.md`'s Payment entity
   text is updated to match, not just the schema.
4. **`idempotency_keys` plural table name — confirmed intentional, no change.** Not worth further
   attention.

**Plus one Founder-requested extension to §6's CHECK constraint recommendation:** rather than only
"at most one of refund_id / chargeback_id / adjustment_id is set," the constraint now also
requires that whichever one is set (or none) agrees with `entry_type`. Implemented as a single
`CHECK` in `apps/backend/prisma/sql/ledger_integrity.sql` — see the revised §6 and §7 below.

**A second bug caught while authoring that SQL, before any of it was applied anywhere:** writing
`entry_type = 'refund_issued'` in the CHECK constraint required knowing the actual lowercase value
Postgres would store — and it wouldn't have matched. The first draft of every Prisma enum in
`schema.prisma` left individual values unmapped, so Prisma would have stored them uppercase
(`REFUND_ISSUED`) at the database level, contradicting `DATABASE.md`'s literal lowercase values
(`entry_type (payment_captured / tip_allocated / refund_issued / ...)`) and silently breaking the
CHECK constraint being written against them. Fixed: every value in all eleven enums now carries an
explicit `@map` to lowercase snake_case. Caught by the same discipline as the currency-FK bug in
§5 below — reviewing the schema again immediately before depending on it for something new, not
trusting the first draft.

---

## 1. Foreign Key Index Coverage

Every foreign key column in `schema.prisma` is indexed — via an explicit `@@index`, or implicitly
via `@unique` / `@id` / a composite `@@id`. This matters because **Prisma does not automatically
index foreign key columns** the way some ORMs do; each one below required an explicit annotation.

| Table | FK column(s) | Mechanism |
|---|---|---|
| restaurant | organization_id | `@@index` |
| restaurant | currency | `@@index` |
| membership | user_id, organization_id, restaurant_id, role_id | `@@index` each (matches Index Strategy literally) |
| role_permission | role_id, permission_id | composite `@@id` (covers role_id-led lookups) + separate `@@index([permissionId])` for the reverse |
| wallet | membership_id | `@unique` |
| wallet | currency | `@@index` |
| payment | restaurant_id | `@@index` |
| payment | idempotency_key | `@unique` |
| payment | currency | `@@index` |
| transaction | payment_id | `@unique` |
| transaction | restaurant_id | `@@index`, plus composite `@@index([restaurantId, createdAt])` (Index Strategy — dashboard queries) |
| transaction | currency | `@@index` |
| journal_entry | transaction_id | `@@index` |
| journal_entry | refund_id, chargeback_id, adjustment_id | `@@index` each (ADR-017, revised direction) |
| ledger_line | journal_entry_id, membership_id, restaurant_id | `@@index` each (Index Strategy, named explicitly) |
| ledger_line | currency | `@@index` |
| tip | transaction_id | `@unique` (Transaction → zero-or-one Tip) |
| tip | currency | `@@index` |
| refund | transaction_id | `@@index` (many Refunds per Transaction, by design) |
| refund | requested_by, approved_by | `@@index` each |
| refund | currency | `@@index` |
| chargeback | transaction_id | `@@index` |
| chargeback | currency | `@@index` |
| adjustment | restaurant_id, membership_id, created_by | `@@index` each |
| adjustment | currency | `@@index` |
| idempotency_keys | key | `@id` |
| idempotency_keys | expires_at | `@@index` (Index Strategy — not a FK, but the purge-job's query) |
| outbox_event | published_at | `@@index` (Index Strategy — the poller's query) |
| audit_log | user_id | `@@index` |
| audit_log | entity, entity_id | `@@index` composite — not in DATABASE.md's Index Strategy list explicitly, added because it is AuditLog's own stated purpose ("who did what to this record") and no other index supports that query |

**Verdict: pass.** Every FK is covered, including the three new ones on `journal_entry` after the
ADR-017 revision. The one addition beyond DATABASE.md's literal Index Strategy list
(`audit_log(entity, entity_id)`) is flagged above rather than silently added.

---

## 2. The Debit = Credit Invariant (ADR-002) — Trigger Approved for Sprint 1

**Question asked directly by the Founder: how is this actually enforced, given Postgres cannot
check an aggregate across multiple rows with a plain `CHECK` constraint?**

Correct — a `CHECK` constraint only ever sees one row at a time. `SUM(LedgerLine.amount WHERE
direction = debit) = SUM(... credit)` is an aggregate over every `LedgerLine` sharing one
`journal_entry_id`, so it cannot be expressed as a column- or row-level constraint at all, in any
database. This schema needs two independent layers, not one:

**Layer 1 — primary enforcement, application layer.** `IMPLEMENTATION_PLAN.md` (Sprint 1)
already commits to this: a single Ledger Module write-helper is the *only* code path permitted to
insert `JournalEntry` + `LedgerLine` rows (`SYSTEM_ARCHITECTURE.md`: "the only module permitted to
write a double-entry posting"). Before committing the surrounding database transaction, that
helper sums the debit and credit lines it is about to write and aborts if they disagree. This is
necessary but, by itself, only as strong as "nothing ever bypasses this module" — true today, not
guaranteed forever (a future migration script, a raw SQL fix, or a bug could write directly).

**Layer 2 — defense in depth, database layer. Approved by the Founder; now a Sprint 1 task in
`IMPLEMENTATION_PLAN.md`.** A Postgres **deferred constraint trigger** on `ledger_line`: `AFTER
INSERT OR UPDATE OR DELETE ... FOR EACH ROW`, declared `INITIALLY DEFERRED`. Deferred is the
essential detail — a normal (non-deferred) trigger fires immediately after each row, which would
reject the *first* line of every multi-line `JournalEntry` before its balancing line exists in the
same transaction. A deferred trigger instead runs once at `COMMIT`, after every line in the
transaction has been written, and can then safely sum by `journal_entry_id` and raise an exception
if any entry is unbalanced. This is a database-level guarantee that holds even if the
application-layer helper is ever bypassed.

**Why this isn't in `schema.prisma` yet:** Prisma has no way to express a trigger — this requires
hand-written SQL in a migration file (`prisma migrate dev --create-only`, then edit the generated
`migration.sql`). Sprint 0 explicitly stops before any migration touches a real database, so no
migration exists yet to add this to. It is now written into `IMPLEMENTATION_PLAN.md` Sprint 1 as
an explicit task, to be authored alongside the write-helper it backs up.

---

## 3. Naming Convention (snake_case)

**Verdict: pass.** Model and field names in `schema.prisma` are idiomatic Prisma/TypeScript
(`PascalCase` models, `camelCase` fields) — every field whose camelCase spelling differs from its
snake_case column name carries an explicit `@map(...)`, and every model carries `@@map(...)` to
its snake_case table name. This was verified mechanically (grep for every multi-word field,
confirmed each either has `@map` or is a virtual Prisma relation field with no physical column).
The actual database schema — table names, column names — is 100% snake_case, matching
`DATABASE.md`'s Naming Convention section exactly. The camelCase in the `.prisma` file itself is a
presentation-layer convention (what `PrismaClient` exposes to TypeScript), not a deviation from
the documented DB-level rule.

One naming inconsistency was carried forward **literally, not silently fixed** (see §9, still
open): DATABASE.md's own Index Strategy section writes `idempotency_keys.key` and
`idempotency_keys.expires_at` — plural — while every other table in that same section is singular
(`ledger_line`, `wallet`, `outbox_event`, `transaction`, `membership`). This schema maps
`IdempotencyKey` to `idempotency_keys` (plural), matching what's actually written twice in the
source document rather than assuming it's a typo.

---

## 4. Soft Delete Correctness

**Verdict: pass.** Mechanically confirmed: `deletedAt` (`@map("deleted_at")`) appears on exactly
four models — `Organization`, `Restaurant`, `User`, `Membership` — and zero others. It is
specifically absent from `Payment`, `Transaction`, `JournalEntry`, `LedgerLine`, `Tip`, `Refund`,
`Chargeback`, `Adjustment`, and `AuditLog`, matching DATABASE.md's Soft Deletes section exactly.
`OutboxEvent` and `IdempotencyKey` have neither `deletedAt` nor any soft-delete field — they are
operational tables purged on a retention schedule (hard delete via a scheduled job), which is a
different mechanism than soft delete and correctly has no schema representation of its own.

---

## 5. A Bug Found and Fixed During Self-Review

While re-reading my own first draft (`CLAUDE_RULES.md`, "Never Trust Yourself" — search for
mistakes before handing work over): `Restaurant.currency` and `LedgerLine.currency` had a real
Prisma relation to `Currency.code`, but seven other money-bearing entities —
`Wallet`, `Payment`, `Transaction`, `Tip`, `Refund`, `Chargeback`, `Adjustment` — had `currency`
modeled as a bare `String` with no relation and no FK. DATABASE.md's Currency entity states the
rule generally ("every monetary amount elsewhere in this schema is interpreted using this table's
exponent for its currency"), not just for Restaurant, so leaving those seven fields unconstrained
would have let an invalid or misspelled currency code slip into Ledger data — precisely the kind
of thing "Money Is Sacred" (`CLAUDE_RULES.md`) exists to prevent. Fixed: all nine currency-bearing
tables now carry a real FK relation to `Currency.code`, and `Currency` carries the matching
back-relation array for each.

---

## 6. Assumptions Made (flagged, not hidden)

DATABASE.md does not enumerate a fixed value set for several `status`-shaped columns, and does
not give a field list at all for two entities. Each is marked `/// ASSUMPTION` directly in
`schema.prisma` as well as here, so nothing is a silent guess:

- **`EntityStatus`** (`ACTIVE` / `INACTIVE` / `SUSPENDED`) — used for `Organization.status`,
  `Restaurant.status`, `User.status`, `Membership.status`, `Wallet.status`. DATABASE.md never
  enumerates these.
- **`OnboardingStatus`**, **`PaymentStatus`**, **`TransactionStatus`**, **`TipStatus`**,
  **`RefundStatus`**, **`ChargebackStatus`** — same gap; each modeled on the lifecycle the
  relevant sequence diagram or ADR actually describes (cited inline in `schema.prisma`).
- **`Role` / `Permission` fields** — DATABASE.md gives no field list at all for either (just
  example values). Filled from the general Database Principles section (UUID id, name,
  description, timestamps) rather than invented ad hoc.
- ~~`Payment` has no `updated_at`~~ — **resolved, ADR-018.** `Payment` now has `updated_at`, and
  `PaymentStatus` gained `DECLINED` alongside `FAILED`. See revision note above.
- **Package manager: pnpm**, for the Sprint 0 repository scaffold. No document specifies one;
  pnpm was chosen as the standard fit for a `packages/` + `apps/` TypeScript monorepo. Easily
  changed — no code depends on it yet.
- ~~At most one of refund_id / chargeback_id / adjustment_id~~ — **resolved and extended,
  Founder-requested.** The CHECK constraint now enforces both mutual exclusivity *and* that
  whichever FK is set (or none) agrees with `entry_type`. Implemented in
  `apps/backend/prisma/sql/ledger_integrity.sql`, ready to apply once a baseline migration exists
  (see that file's header for the exact steps — this session still has no way to run
  `prisma migrate`).
- **Enum values now explicitly mapped to lowercase snake_case at the DB level** (all eleven
  enums) — a bug caught while writing the CHECK constraint above, not present in the original
  audit because nothing had yet depended on the literal stored values. See revision note above.

---

## 7. ADR-017 — Resolved by the Founder (see Revision Note above)

Original finding: `DATABASE.md`'s `Refund`, `Chargeback`, and `Adjustment` entities each declare a
**Relationships** line pointing to `JournalEntry` ("the compensating entry") with no corresponding
column in their **Fields** list. This had to be resolved to write a working schema.

The first draft's recommendation (unique `journal_entry_id` on each of the three) was **rejected
by the Founder** on a specific, concrete correctness basis: ADR-016 already establishes that a
Chargeback can produce two compensating JournalEntries (provisional loss, then reversal-if-won) —
a one-to-many relationship a unique FK cannot represent. The Founder's chosen direction —
JournalEntry owns nullable `refund_id` / `chargeback_id` / `adjustment_id`, mirroring the existing
`transaction_id` pattern — is now implemented in `schema.prisma` and recorded as ADR-017,
**Accepted**, in `ARCHITECTURE_DECISIONS.md`. This is now closed; see §6 above for the one
follow-on integrity check it introduces (the `CHECK` constraint recommendation).

---

## 8. Stale Cross-Reference Fixed (not a new ADR — no decision was actually open)

`IMPLEMENTATION_PLAN.md` and `ARCHITECTURE_REVIEW_REPORT.md`'s summary table still said ADR-012
(launch market) "remains Proposed," while `ARCHITECTURE_DECISIONS.md` itself has marked ADR-012
**Accepted** (Lithuania, EUR) since that document's own last revision, and
`ARCHITECTURE_REVIEW_REPORT.md` §5 already said as much in prose two sections below its own
table. Since `ARCHITECTURE_DECISIONS.md` is the stated source of truth for architecture and the
decision content was already fully specified, this was a documentation staleness bug, not an open
question — corrected in both files rather than escalated as a new ADR.

---

## 9. Open Questions — All Closed

~~ADR-017 FK direction~~ — resolved, first revision (§7). ~~Ledger deferred trigger~~ — approved,
first revision (§2). ~~Payment mutability~~ — resolved as ADR-018, this revision. ~~`idempotency_keys`
plural table name~~ — confirmed intentional, this revision, no change made.

Nothing remains open from this audit. Sprint 1 is Founder-approved as of this revision.

---

## 10. What Was Not Done, On Purpose

No `prisma migrate dev` was run, and no migration files exist yet — Sprint 0 explicitly stops here
for Founder review before anything touches a real database. The deferred trigger (§2) and the
`CHECK` constraint (§6) are both approved/recommended additions to that eventual migration, not
things this session wrote raw SQL for — there is no migration yet to add them to. Production
Dockerfiles for `apps/backend` / `apps/frontend` were not written in Sprint 0, since those apps
don't exist as real, buildable NestJS/Next.js code yet (Sprint 1) — writing a Dockerfile against
placeholder apps would itself need rewriting the moment real code lands, which is the kind of
half-finished artifact `CLAUDE_RULES.md` says not to produce. Sprint 0's Docker deliverable is the
local development Compose stack (`docker/docker-compose.yml` — Postgres, Redis), which is real and
usable today.
