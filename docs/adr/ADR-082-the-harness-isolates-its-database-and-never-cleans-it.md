---
title: ADR-082 — The harness isolates its database and never cleans it
version: 2.0.0
status: Accepted
classification: Important
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-082 — The harness isolates its database and never cleans it

**Status:** **Accepted** (Sprint 16), 2026-09-11 — **option A, truncate before the run.** The
measurement below stands as written; the options section now records which was taken and why, and
the falsifications at the end were executed rather than proposed.

**This is one property, not four incidents.** Accumulated rows were diagnosed separately in #177,
#180, #185 and #194, and each time the answer was "run `db:reset`". That is treatment of the case.
The property is that the harness never cleans up, and it produces a new case on a schedule.

---

## The half that was built, and the half that was not

`apps/e2e/playwright.config.ts` already states the intent, in the comment introducing the separate
database:

> A database of its own … **Separate so a run can truncate freely** without touching whatever a
> developer has in their dev database — the reconciliation suite has already been derailed once by
> accumulated local rows, and an e2e run creates users on every execution.

The isolation was built. The truncation it exists to permit was never written, and nothing in the
comment says so — it reads as a description of a working arrangement. `prepare-database.ts` creates
the database if absent, runs `prisma migrate deploy`, runs the seed, and stops. There is no
`globalSetup` and no `globalTeardown` in the config at all.

**The failure it was meant to prevent is the one it now produces**, one database over.

## What accumulates, measured

Census of `hospitality_os_e2e` on 2026-09-11, after roughly 96 suite runs:

| | tables | rows |
|---|---|---|
| Test residue | 20 | **50,589** |
| Reference data + schema bookkeeping | 5 | 71 |

**26 MB**, against 13 MB for the developer's own `hospitality_os` — the test residue is already
twice the weight of everything a person put there by hand.

**Rate, measured across one full run rather than inferred from the total:**

```
+183  audit_log              +13  shift                 +2  email_delivery
 +56  user                   +11  journal_entry         +2  membership_invitation
 +56  agreement_acceptance    +7  idempotency_keys      +2  outbox_event
 +48  membership              +7  payment
 +47  organization            +7  transaction
 +47  restaurant             +40  ledger_line
```

**+528 rows per run, across 15 of the 20 residue tables.** Nothing bounds it. The 50,589 rows
standing today are simply what 96 runs produce.

## What must survive a cleanup: one table, and it is not the reference data

This is the part that was established rather than assumed, because getting it wrong in either
direction is expensive — preserving too much leaves the problem, preserving too little destroys
something the seed cannot rebuild.

**The seed is the complete producer of all reference data.** `prisma/seed.ts` writes exactly four
tables — `currency`, `permission`, `role`, `role_permission`, 58 rows between them — and writes them
with `upsert`, additionally *deleting* `role_permission` rows that should not exist. It does not
top up a partial table; it drives the table to a declared state from whatever it finds, including
nothing. `db:prepare` already calls it on every run.

**No migration creates reference data.** All 13 migrations were read for data statements. There is
exactly one — `20260822074559_sprint13_user_display_name`:

```sql
UPDATE "user" SET "display_name" = split_part(email, '@', 1) WHERE "display_name" IS NULL;
```

A backfill over rows that already exist. It creates nothing. Had any migration inserted reference
rows, truncation would have destroyed them permanently: the seed does not know them, and
`migrate deploy` will not re-run an applied migration.

**So the answer is `_prisma_migrations`, and nothing else.** It is not data; it is the record of
which migrations have been applied. Truncate it and `migrate deploy` tries to create tables that
already exist, and the next run fails at step one.

**Why that answer matters more than it looks.** "Truncate everything except these four reference
tables" is a hand-written list, and this codebase has twice watched a hand-written list go stale —
`test/global-setup.ts`'s permission matrix, and ADR-058's allow list. "Truncate everything except
`_prisma_migrations`" is derived from `information_schema`: a table added next sprint joins the
sweep by existing, not by somebody remembering. The two differ by one line of code and by whether
the mechanism has a handle somebody can loosen.

**Verified by execution, not left as a reading.** Everything above is derived from `seed.ts`, the
migrations and the schema catalogue — a strong reading, and still a reading, and this repository's
own rule is that a claim stronger than "the string is present" needs an execution that would fail
without it. So it was run, on the Founder's explicit authorisation for this database:

```
truncate 24 tables, preserve _prisma_migrations   -> reference 0, user 0, audit_log 0, migrations 13
pnpm --filter e2e run test:e2e
  prisma migrate deploy   -> "13 migrations found ... No pending migrations to apply."
  prisma:seed             -> "Seeded 14 currencies." / "Seeded 10 permissions and 5 roles."
  playwright              -> 68 passed (2.8m), exit 0
reference data afterwards -> 14 + 10 + 5 + 29 = 58, identical to before the truncation
```

Three things this settles that reading could not. `migrate deploy` reported **no pending
migrations** — so preserving `_prisma_migrations` was both necessary and sufficient, and the rest of
the schema survived `TRUNCATE` untouched. The seed rebuilt all 58 reference rows **from zero**, which
is the claim that would have been expensive to get wrong. And the suite passed from a completely
empty database, so nothing in it depends on residue from an earlier run — a dependency that would
have been invisible for as long as the residue happened to be there.

**A fourth thing came free, and it is the useful one:** a single run from empty left **exactly 528
rows**, matching the per-run rate measured independently above against a database holding 50,589.
Two measurements taken different ways agreeing is worth more than either: the growth is linear and
per-run, not a function of what is already there. The database went from 27 MB to **10 MB**.

---

## Options

### A — Truncate before the run — **ACCEPTED**

In `prepare-database.ts`, after `migrate deploy` and before the seed. Implemented as
`fixtures/truncate.ts`.

**Buys:** every run starts from a known state, so a failure is reproducible from the same beginning
rather than from a different one each time. It also leaves the previous run's rows in place until the
next run starts — so a suite that just failed can still be inspected, which is the property
`CLAUDE.md` protects when it says a cause is isolable exactly once.

**Price:** nothing bounds a *single* run's footprint; the database still grows to 528 rows during a
run and stays there until the next one. A developer opening the database between runs sees residue
and may reasonably think the cleanup is not working.

**The Founder's reasoning, recorded because it is the part worth keeping:**

> The rows of a failed run are evidence. The database is one more place where the cause is visible,
> alongside the log and the trace. Cleaning up afterwards destroys it on the run that is the most
> interesting of all.
>
> A teardown does not execute on killed and crashed runs — that is, on exactly the ones whose
> residue confuses people later. Cleaning up afterwards cleans the cases that were already clean.

**The price is accepted explicitly**, not accepted by omission: growth within a run is unbounded, the
528 rows remain, and the next run removes them.

**On the form, and it is not a detail.** The list is derived from `information_schema`, never
written as an array of names. A written list is a list somebody edits to turn a red run green; a
derived list has no handle to loosen, and a table added by next sprint's migration joins the sweep
by existing rather than by being remembered.

### B — Truncate after the run

A `globalTeardown`, which the config does not currently have.

**Buys:** the machine is left clean, and the database never holds residue between runs.

**Price:** **it destroys the evidence of the run that just failed** — the rows are gone by the time
anyone reads the log, and the repository's own rule is that the state a cause can be seen in is
overwritten exactly once. It is also the weaker guarantee of the two: a teardown does not run when a
run is killed, crashes, or is interrupted — precisely the runs whose residue is most confusing
later.

### C — A transaction per test file, rolled back

**This one is not available to this harness, and the reason is structural rather than a preference.**

Two independent blocks, both from the harness as it stands:

1. **The backend is a separate process.** `playwright.config.ts` starts it as
   `webServer: pnpm --filter backend run start`, and the tests drive it over HTTP. A transaction
   opened by the harness is invisible to the backend's own connections, so every row the application
   creates — users from registration, payments, `audit_log` — commits outside it.
2. **The harness's own writes commit immediately.** `fixtures/db.ts` opens a new `Client`, connects,
   queries and ends on *every* call. There is no long-lived connection to hold a transaction open on.

A rollback would therefore undo part of the harness's seed writes and none of the application's.
**That is worse than no cleanup at all**, because it looks like cleanup: it would close the question
without answering it, and the next person to find residue would be looking for a second cause.

Reworking both — a per-file connection in the harness, and the backend joining the harness's
transaction — is not a cleanup strategy but a different harness. It would also change what the suite
proves: work that never commits cannot exercise commit-time behaviour, and the outbox poller reads
committed rows by design.

### D — Nothing

**Price:** the next accumulation incident, then the one after. Four are already recorded, each
answered individually. **Buys:** nothing, and the cost is paid by whoever is diagnosing something
else at the time.

---

## Falsification — executed, not proposed

Four claims, each run against the case that would fail if the implementation were wrong.

**1. A run from a dirty database ends at the same census as one from a clean database.** Started at
528 residue rows, ran the suite twice:

```
start:  residue=528
run 1:  72 passed (2.7m)  ->  residue=528  reference=58  migrations=13  size=10 MB
run 2:  72 passed (2.7m)  ->  residue=528  reference=58  migrations=13  size=10 MB
```

Without the sweep those runs read 1,056 and 1,584. The figure is now a **fixed point** rather than a
running total, which is the whole claim.

**2. `_prisma_migrations` must survive, and an implementation that truncates it must fail.**
Falsified by breaking it deliberately, on a scratch database rather than the suite's own: truncate
the bookkeeping, run `db:prepare` again, and it fails —

```
Error: P3018  A migration failed to apply.
Database error code: 42710
ERROR: type "entity_status" already exists
```

**It fails on a TYPE, not on a table**, which is the more useful half of the result: `TRUNCATE`
empties tables and leaves every other schema object — types, sequences, indexes — in place, so
re-applying the first migration collides immediately. A wrong implementation does not degrade
quietly; it stops at the first step of the next run with a named error code.

**3. A table nobody listed is swept because it exists.** `tests/harness-cleanup.spec.ts` creates
`arrived_in_a_later_migration` at runtime, named in no array anywhere, and asserts the sweep covers
it. **A list-based implementation passes every other test in that file and fails this one** — which
is what makes it a falsification of the form rather than a demonstration of the function.

**4. Foreign keys do not dictate an order.** `child` references `parent`; truncating them one at a
time in catalogue order fails on the first. The test asserts both are in a single `TRUNCATE`.

The first three tests run against a **throwaway database the spec creates and drops**, because a
sweep pointed at the suite's own database would delete the rows the rest of the run is asserting on.
The fourth assertion in that file is the only one touching the real database, and it only reads: it
fails if the sweep were ever placed *after* the seed, since the reference tables would be empty.

---

## What this does not close

**Growth within a run is still unbounded** — that is the accepted price, not an oversight. If a
single run's footprint ever matters, the measurement to take first is whether 528 is stable across
sprints or grows with the suite.

**Out of scope here, deliberately:** the outbox retry loop that has no ceiling, recorded in
`SYSTEM_ARCHITECTURE.md` — it is the reason 132 of those residue rows can never publish, but it is a
separate axis and fixing it here would confuse two changes in one attribution (ADR-058).
