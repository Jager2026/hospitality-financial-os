---
title: ADR-086 — The harness owns the rows it leaves
version: 1.0.0
status: Accepted
classification: Important
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-086 — The harness owns the rows it leaves

**Status:** Accepted (Sprint 16), 2026-09-13. Closes the accumulation
[ADR-084](ADR-084-two-bounded-queues-that-never-drain.md) measured and
[ADR-085](ADR-085-a-queue-with-only-one-exit.md) deliberately did not fix.

---

## The number, measured rather than estimated

A full backend suite leaves **+17 stuck `PENDING` payments** behind — 16 with no Transaction at all
and 1 with a Transaction shell. Counted directly, before and after one run:

```
before:  76 bare + 14 with a Transaction = 90
after:   92 bare + 15 with a Transaction = 107
```

`PaymentReconciliationService` selects the oldest **100**, so from an empty database the sixth run
crosses the bound. **Reproduced rather than inferred:** at 102 stale rows on `main`, the
reconciliation spec lost **five tests** — including two of ADR-085's own — to rows that have nothing
to do with the code under test:

```
AssertionError: a canceled PaymentIntent left its Payment in PENDING
AssertionError: a still-open Payment stopped being checked: expected 0 to be greater than 0
```

Both assertions are about the queue, and neither failure was.

## Why ADR-085 did not fix this, and should not have

Those rows are **honestly non-terminal**. Under a spec's own fake Stripe they answer
`requires_payment_method`, which means the payment could still be completed — exactly the case
ADR-085 refused to conclude, because concluding it safely means cancelling a customer's live payment
at Stripe after a window nobody can measure at zero traffic. The product is right and the litter is
still litter. This is a harness problem wearing a product problem's clothes, and the two needed
separating before either could be answered.

---

## Decision: the sweep is a property of the harness, not a habit of the author

`test/global-setup.ts` removes the stuck `PENDING` rows a previous run left, **before** this run
starts. No spec imports anything, registers anything, or has to remember anything.

### Why not per-spec cleanup, with the cost of that alternative stated

Twelve spec files create Payment rows across fourteen call sites:

```
analytics · dashboard · permission-scope.e2e · outbox-poller · payment-reconciliation (×2)
payment · tip · transaction · wallet-projection (×2) · wallet.controller · wallet · webhooks
```

Two things rule it out, and the second is decisive rather than merely expensive:

1. **Twelve edits is a cost paid again by every spec written afterwards.** A convention that lives
   in twelve places is followed until the thirteenth spec, and the thirteenth is always the one
   written in a hurry. `CLAUDE.md`'s own rule about mechanisms that need routine cooperation applies
   here in its milder form: what everybody has to remember, somebody will not.
2. **Two of those specs cannot do it at all.** `permission-scope.e2e.spec.ts` and
   `critical-flow.e2e.spec.ts` drive the real HTTP pipeline, so the Payment is created by
   `PaymentService` inside the request and the spec never learns its id. No helper, no fixture and
   no teardown in those files can register a row they never see. Any design that relies on the spec
   knowing what it created is already incomplete before it is written.

### Why before the run and not in a teardown

[ADR-082](ADR-082-the-harness-isolates-its-database-and-never-cleans-it.md)'s finding, reused rather
than rediscovered: **a teardown does not run on a killed or crashed run**, and those are the runs
that leave the most behind. Cleaning at the start means the sweep has already happened by the time
anything can go wrong with it. It is the same shape as that decision — truncate before, not after —
narrowed to what a development database can afford to lose.

### What it deletes, and why the rule is structural

Not by age, and not by any naming convention. A fixture-name matcher rots the first time a fixture
is renamed, and an allow list is a file somebody edits to make the build green — the rubber-stamp
decay `CLAUDE.md` describes, and the reason ADR-084's option B was refused. Two shapes, both of
which the **product cannot produce**:

1. **A `PENDING` Payment with no Transaction.** The product creates one only in the seconds between
   a waiter presenting the terminal and a guest paying. Nobody is in that window at the instant a
   suite starts, and a developer who was can start the payment again.
2. **A `PENDING` Payment whose Transaction has no JournalEntry and no Tip.** In the product a
   Transaction is written by the `payment_intent.succeeded` handler, on the same path that posts the
   Ledger and sets the Payment `SUCCEEDED`. A completed Transaction with no Ledger behind it, over a
   Payment still `PENDING`, is a row a fixture assembled by hand — measured: all 16 in the
   development database had exactly zero of each.

**Anything with a JournalEntry or a Tip behind it is left alone and counted in the printed line.**
That is financial history, and no test-harness convenience is worth deleting it. If that count ever
starts growing, it is saying something a sweep must not answer on its own.

### It deletes rows it did not create, and that is said out loud

This is a rule about a development database, not about this run's own rows — the sweep cannot tell
which previous run left what, and does not try. `assertLocalDatabase` is what keeps that sentence
survivable: it asks the server `inet_server_addr()` rather than trusting a connection string, and
refuses anywhere that is not this machine or a private network.

That guard already existed inside `seed-portal-demo.ts`. It was **extracted to
`prisma/database-locality.ts` rather than copied**, because a rule about where it is safe to delete
rows is the last thing that should exist in two hand-written versions — this repository has watched
a hand-copied permission matrix drift four Permissions and three Roles out of date, and ADR-011
exists because two copies of one document answered the same question differently.

## The email half, and a claim this document had to take back

The first version of this decision swept payments only, and said in as many words that **the outbox
needed no sweep**, on the grounds that 775 unpublished events contained only **16 eligible** ones —
the rest being past ADR-075's twenty-four-hour window or already concluded by ADR-085.

The next full gate run failed on `OutboxPollerService`'s alerting spec, which lost its own event
behind **51 eligible rows**. Sixteen was a *snapshot*, and it was read as a *property*. Email events
fail, back off, and become eligible again in waves, so the eligible count breathes across the batch
size of 50 rather than sitting still under it — and the window that does finally end them is a day,
which is longer than an afternoon of work.

**The rule for these is a fact about the environment rather than about the rows.**
`EmailService.send` refuses outright unless `NODE_ENV === "production"` — a deliberate decision
with its own comment, so that the e2e suite cannot make live calls to Resend with a placeholder key.
An email event written anywhere else is therefore **unpublishable by construction**: not old, not
named like a fixture, not merely stuck. It cannot succeed here, which is precisely what
`PermanentRejection` means.

**So the harness marks these rather than deleting them**, using ADR-085's own `abandoned_at` and
`abandoned_reason`. That respects ADR-075's reasoning where deletion would not: the row is the
trace of a send that was decided on, and removing it would destroy that record while leaving the
recipient's address one table over in `EmailDelivery` anyway. It also means the mechanism is the
product's, used by the harness, rather than a second mechanism invented for tests.

The discriminating pair is a money event of the same age, which must **not** be concluded — a rule
written as "abandon what has not published" would pass the email test and fail that one, and the
damage would be a Wallet left permanently wrong rather than an email not sent.

---

## Falsification

**At the suite level, on the same database and the same code under test:** five reconciliation tests
failed at 102 stale rows; with the sweep in place the run reports `[db] swept 124 stuck PENDING
payments left by earlier runs` and **437 of 437 pass**. After that run the database holds 17 again —
the per-run figure, and it can no longer compound.

**At the unit level, five tests in `test/harness-sweep.spec.ts`**, two of which are the halves that
reject a lazier version of their own mechanism.

| test | rejects |
|---|---|
| takes a bare `PENDING` row, and the Transaction shell of one with no Ledger | a sweep that does nothing |
| **REFUSES a `PENDING` row with a JournalEntry behind it** | **a sweep that deletes everything stuck** |
| never considers a row that is not `PENDING` | a sweep whose status filter is missing |
| concludes an unpublished email event, keeping the row and its reason | a conclusion that deletes, or one that does nothing |
| **REFUSES a money event of the same age** | **a rule written as "abandon what has not published"** |

The third exists for a specific reason. The sweep takes an optional `onlyPaymentIds` narrowing —
used **only** by that spec, because calling the real unrestricted sweep from inside a running suite
would delete the in-flight payments of every spec executing in parallel beside it. The narrowing
applies *in addition to* every rule, never instead of one, but it cannot prove the `status: "PENDING"`
filter; so that spec seeds a `SUCCEEDED` row of its own and asserts it survives.

---

## Also closed here, because it is the same hole

`tsconfig.typecheck.json` covered `src/`, `test/` and `prisma/` and **not `scripts/`** — while its
own comment argued that "a file that can revoke permissions in production should not be the one file
nobody's compiler looks at". `scripts/redact-user.ts` erases a real person's personal data on
request and `scripts/seed-portal-demo.ts` deletes and rebuilds an Organization; both were outside
every compiler in this repository.

Adding `scripts/**/*.ts` surfaced **zero** errors. The include was then verified the way any new
instrument has to be (`CLAUDE.md`, Workspace Hygiene): a type error was planted in `scripts/` and
confirmed reported, then removed and the run confirmed clean. A pattern matching nothing would have
looked exactly like a clean pass.

---

## What this does not do

- **It does not make the development database clean**, only its two queues non-accumulating.
  Organizations, restaurants and ledger entries still grow, and `pnpm run db:reset` remains the
  answer when a failure smells of stale data.
- **It does not replace ADR-085's open case.** An abandoned payment in production still stays
  `PENDING` forever; this sweep exists on exactly one machine and reaches nothing a customer touches.
