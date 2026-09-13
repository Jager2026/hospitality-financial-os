---
title: ADR-088 — One ACTIVE Membership per scope, and the constraint that says so
version: 1.1.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-088 — One ACTIVE Membership per scope, and the constraint that says so

**Status:** Accepted (Sprint 16), 2026-09-13. Closes the race found by reading in the
read-modify-write survey, **after reproducing it** — and adds the constraint that makes the rule
unnecessary to remember.

---

## Reproduced first, five runs out of five

`MembershipInvitationService.accept` read the `User` outside its transaction, then ran two long
calls — `isPasswordBreached` (a network request to HIBP) and `hashPassword` (bcrypt at this
project's cost factor) — and only then opened the transaction that creates the `Membership` and
stamps the invitation. The invitation lookup filters `acceptedAt: null`, so the **read** was
guarded; the stamp was `update({ where: { id } })` with no condition, so **nothing serialised two
accepts.**

Two concurrent `accept()` calls with one token, against the real database:

```
run 1..5:  expected 2 to be 1
```

**Deterministic, not a flake.** One invitation, two Memberships — by ADR-006 that is two Wallets for
one person at one employer, with their tips split between them.

### Which half reproduces, and why that is the argument for the constraint

With a **brand-new** email both callers reach `createUserAccount`, and `User.email @unique` aborts
the second transaction. That path was safe — **by a constraint that happens to exist**, not by
anything the code does.

With an **existing** User — somebody already on the platform, invited somewhere new — both callers
skip creation, both create a Membership, and nothing stands in the way at all.

The code was safe exactly where a constraint was, and nowhere else. That is the whole case for
§3 below.

---

## The fix, in three parts, and the first one is not a fix

### 1. `hashPassword` leaves the read→write interval

It touches no database and had no business sitting between the snapshot and the write. It is now
before the transaction and no longer conditional on the snapshot — it hashes whenever a password was
supplied, at the cost of one wasted hash when somebody sends a password for an account that already
exists.

**On its own this would have been the wrong change, and it is recorded that way on purpose.**
Removing a few hundred milliseconds from the window makes the defect *rare* rather than *absent* —
and a rare concurrency defect is harder to diagnose than a reliable one. Had this been applied
alone, the five-out-of-five reproduction would have become a once-in-a-while report from
production with nothing to reproduce.

### 2. The invitation row is claimed first, inside the transaction

```ts
const claimed = await tx.membershipInvitation.updateMany({
  where: { id: invitation.id, acceptedAt: null },
  data: { acceptedAt: new Date() },
});
if (claimed.count !== 1) throw new AppException("INVITATION_INVALID", …);
```

Whoever flips `accepted_at` from NULL wins; `count` says which caller that was. The second accept
gets 0 and stops **before creating anything**. The invitation row is the right thing to serialise on
because it is the one row both callers must touch, and there is exactly one per acceptance by
definition.

**The idiom is already in this codebase** — `RestaurantService.createOnboardingLink` writes
`where: { id, onboardingLinkFirstRequestedAt: null }` for the same reason. No new pattern was
introduced; an existing one was applied where it was missing.

The `User` is then read **inside** the same transaction. The outer read survives, but its job is now
only to decide what the *request* had to supply — never what gets written.

### 3. The constraint, because §2 is a rule

`membership_one_active_per_scope`, a partial unique index in the migration:

```sql
CREATE UNIQUE INDEX "membership_one_active_per_scope"
  ON "membership" ("user_id", "organization_id", "restaurant_id")
  NULLS NOT DISTINCT
  WHERE "status" = 'active';
```

§2 is correct and it is *a rule in one code path*. The next path that creates a Membership can
simply not apply it, and nobody would notice. A constraint cannot be forgotten in silence.

---

## The form was established, not assumed — and the brief's own conditional had to be corrected

The instruction anticipated a partial index `WHERE deleted_at IS NULL`, on the reasoning that a
removed member leaves a row behind and a full unique index would block re-hiring. **The reasoning is
right and the column is wrong**, and it took reading the code to see it:

- **Removal is `MembershipService.disable`**, which writes `status = 'inactive'` and leaves the row.
  There is no `delete` anywhere.
- **Nothing writes `deleted_at` on a Membership.** `auth/active-memberships.ts` says so in its own
  comment — *"`deletedAt` is included even though nothing writes it on a Membership today"* — and a
  search of the source confirms zero write sites.
- So a partial index on `deleted_at IS NULL` would match **every row**: a full unique index wearing
  a WHERE clause, blocking re-invitation exactly as the full one would.
- **Closing a restaurant touches no membership at all** — `RestaurantService.close` writes
  `deletedAt` and `INACTIVE` on the Restaurant only.
- **Re-invitation is a working scenario**: `invite()` does not check for an existing Membership,
  deliberately.

So the predicate is `status = 'active'`.

### The natural key, and the half that is easy to leave out

`(user_id, organization_id, restaurant_id)`. `organization_id` is not decoration: `restaurant_id` is
**NULL** for an org-wide role (ADR-005), and without the organization such a row would be keyed on
`(user_id, NULL)` alone.

**`NULLS NOT DISTINCT` is what makes the org-wide case constrained at all.** Postgres treats NULLs
as distinct in a unique index by default, so an index without it would leave exactly one case open —
**the widest grant in the system**, a role over every restaurant in an Organization. Measured: 1,450
of the development database's memberships are org-wide. Available since Postgres 15; dev and CI both
run 18.

Prisma expresses neither clause, so the index lives in the migration — the same shape and the same
reasoning as `shift_one_open_per_restaurant`.

---

## Falsification

**The race:** the reproduction failed 5 of 5 before §2 and passes 5 of 5 after. It is kept as a test
rather than deleted, so the next change to this method has to keep it true.

**The constraint:** three tests, and the two that matter say *no* to a lazier index.

| test | rejects |
|---|---|
| a second ACTIVE Membership at one restaurant is refused | an index that is absent |
| **a new ACTIVE Membership beside an INACTIVE one is ALLOWED** | **a full unique index, which would block re-hiring** |
| **a second ACTIVE org-wide Membership is refused** | **an index without `NULLS NOT DISTINCT`** |

The migration was also falsified by the data: applied against a database still holding the
reproduction's duplicates, it **failed** — seven groups — which is the constraint doing its job on
the rows that proved the defect. Those rows were this test's own, carrying zero Wallets and zero
LedgerLines, and the spec now clears them itself.

**`@Throttle` was not touched.** A request limit is not concurrency control, and tightening it would
have looked like a defence while being none.

---

## What this closes, and what it does not

**Closed:** this race, and the *consequence* of a duplicate for `membership`.

**NOT closed: the read-modify-write class.** Two fixes and one constraint are not a mechanism. No
lint rule can see "a value read, a long call, then a write of what was read" — the pattern is about
the interval, not about any token in the source. The candidate list that found this one is what a
search over known-slow calls produced; it is not a maximum, and the survey said so.

What *can* be closed is the consequence, table by table, wherever a duplicate costs money, rights or
identity — which is the measurement below and the scope of a separate change.

---

## Measurement: where else a duplicate costs something

**Not one compound `@@unique` exists in the entire schema.** Every uniqueness in this system is a
single-column `@unique`, plus two partial indexes in migrations.

| table | natural key | constrained? | what two rows mean |
|---|---|---|---|
| `membership` | `(user_id, organization_id, restaurant_id)` while active | **yes, this change** | two Wallets for one person, tips split |
| `payment` | `processor_payment_id` | **no** | two rows for one Stripe charge; `captureFromPaymentIntentId` picks one with `findFirst` |
| `refund` | `processor_refund_id` | **no** | one refund posted to the Ledger twice |
| `chargeback` | `processor_dispute_id` | **no** | one dispute counted twice |
| `restaurant` | `company_number`, `vat_number` | **no** (`stripe_account_id` is) | one legal entity as two venues |
| `role_permission` | `(role_id, permission_id)` | **no** | a duplicate grant — noise, not divergence |
| `agreement_acceptance` | `(user_id, agreement, version)` | **no** | consent recorded twice — audit noise |
| `transaction` | `payment_id` | yes | — |
| `tip` | `transaction_id` | yes | — |
| `wallet` | `membership_id` | yes | — |
| `user` | `email` | yes | — |
| `shift` | `restaurant_id` while open | yes, partial index | — |

**The pattern is legible and it is the finding:** wherever the natural key is a foreign key to one
of our own tables, it is constrained. **Wherever the natural key is an identifier issued by Stripe,
it is not.** Those three — `payment`, `refund`, `chargeback` — are guarded today by rules upstream
(the idempotency key on the request boundary, `claimEvent` on the webhook path), which is precisely
the position `membership` was in this morning.

**No migration for them here.** That is a second risk with its own blast radius — three indexes over
tables holding money, each needing its own check for pre-existing duplicates — and it gets its own
change.

**Done on the same day, in [ADR-089](ADR-089-a-stripe-id-names-one-thing.md)** — and the measurement
there changed what the three rows above mean. Only **one** of them was a reachable defect: a
`charge.dispute.created` delivered twice under different event ids produced two Chargebacks and two
CHARGEBACK journal entries. `payment` and `refund` turned out to be guarded already — by a status
check and by a cumulative-amount guard respectively, both rules in one code path — so their indexes
are assertions rather than fixes. The row above that reads *"guarded today by rules upstream"* was
right about the shape and could not say which of the three the rule actually failed to cover.
