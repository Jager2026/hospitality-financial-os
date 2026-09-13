---
title: ADR-084 — Two bounded queues that never drain
version: 1.1.0
status: Proposed
classification: Important
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-084 — Two bounded queues that never drain

**Status:** Proposed (Sprint 16), 2026-09-12. **Options, none chosen** — the dev database cannot be
truncated before a run the way the e2e database can (ADR-082): demo venues live there and the
Founder looks at them.

---

## The question this started as

After ADR-083's amendment (#201) fixed a clock-skew defect in the outbox poller, one question was
left: **do the `PaymentReconciliationService` and critical-flow failures seen alongside it reproduce?**
If not, the dev database needed no owner and the matter closed.

Both were answered, and differently.

## Critical flow: explained, not merely absent

`critical-flow.e2e.spec.ts` **imports `OutboxPollerService` and calls `poll()` in a loop**, then
asserts the Manager's Wallet reflects the tip. With the clock skew, a freshly written outbox event
was invisible to that poller — so the Wallet never updated and the test ran out its 20-second
budget. The failure is a **consequence of the defect #201 fixed**, by a path in the test's own
source, not a coincidence that happened to stop.

## Reconciliation: reproduced deliberately, and it is the Founder's original hypothesis

`PaymentReconciliationService` touches the outbox **nowhere** — zero references in the service and
in its spec — so the clock skew cannot explain it. Six suite runs after #201 produced no
reproduction, including two against a 446-event outbox backlog. **Six runs of silence is a weak
bound** (0 of 6 puts the 95% ceiling near 39%, which excludes only a very high rate), so it was not
reported as an answer.

It was reproduced by building the condition instead:

```
164 stale PENDING payments (the reconcile batch takes 100)
  -> spec alone, run 1: 6 failed | 1 passed
  -> spec alone, run 2: 6 failed | 1 passed
  -> spec alone, run 3: 6 failed | 1 passed
```

with the **same assertions** recorded in the original failing run — *"expected spy to be called with
arguments"*, *"expected [] to have a length of 1 but got +0"*. Three of three, deliberately, matching
signature.

## The mechanism, stated once for both services

Two services read a **bounded FIFO batch of rows that can never resolve**:

| service | query | bound |
|---|---|---|
| `OutboxPollerService` | `published_at IS NULL`, `ORDER BY created_at ASC` | 50 |
| `PaymentReconciliationService` | `status = PENDING AND created_at < now() - 15m`, `ORDER BY created_at ASC` | 100 |

Both bounds are deliberate and correct — an unbounded query in a real incident is worse. But
**oldest-first plus a bound plus rows that never leave equals a head that never moves.** A test's own
fresh row is at the tail, and it is never reached.

It is not "the database is dirty". It is that **two queues have no way to stop selecting what they
can never finish**, and a development database is simply where that accumulates first.

**A test's own bounded catch-up loop hides this until it cannot.** Both specs poll in loops (up to
40 iterations) precisely because the queue may be busy. That works while the head moves and fails
suddenly when it does not — which is why the symptom arrives as an assertion about the wrong thing,
or as a timeout, rather than as anything naming a queue.

## What the inversion diagnostic said

`CLAUDE_RULES` 2.23.0 records the rule; this is its first application to a case whose answer was
then obtained independently.

- **Outbox, with a heavy backlog:** failed 1 of 2 **in the suite**, passed 3 of 3 **alone** →
  contamination. Correct: the cause is queue depth plus parallel load, and the narrow run has time
  to drain.
- **Reconciliation, with a saturated batch:** failed 3 of 3 **alone** → the ballast *is* the
  variable, and no timing question arises.

Contrast with the defect in ADR-083's amendment, which failed **0 of 3 alone** and passed about 1 in
3 in its own file — a timing window, read backwards for a full session before the two numbers were
put side by side.

## What is NOT established

**Whether either queue's head is growing in the ordinary course or only under test runs.** After
removing this session's own ballast the dev database still held **42 stale PENDING payments** — 42%
of the reconcile batch, accumulated by the project's own work rather than by any experiment here.
Nobody has measured the rate.

---

## Options — none chosen

The constraint that makes this different from ADR-082: **the dev database cannot be emptied before a
run.** Demo venues live in it and are looked at. So the owner here is not a sweep.

### A — Give the unresolvable rows a terminal state

The rows crowding both heads share one property: they can never succeed. An outbox event with no
`journalEntryId` will not acquire one; a PENDING payment from a test that is long gone will not
settle. A terminal state (`abandoned`, `dead`) removes them from the queries by making the query
true rather than by deleting anything.

**This is ADR-083's option D**, recorded there as undecided and reached again from the other side:
it needs a way for a handler to say *"this will never succeed"*, which is a change to the dispatch
contract rather than a cleanup. **Price:** the largest of these options, and it touches the money
path. **Buys:** the only one that fixes the product rather than the environment — a production queue
has the same head.

### B — A dev-only sweep of what tests leave behind

A command that deletes rows a test would have created and nothing else — matched by the fixtures'
own naming, never by age alone. **Price:** a matcher that has to stay in step with the fixtures, and
the failure mode is silent under-deletion. It is also an allow list by another name, which this
repository has watched rot twice. **Buys:** no product change at all.

### C — Order the queues by attempt count rather than by age

`ORDER BY attempts ASC, created_at ASC` puts never-tried rows at the head, so a fresh row is reached
whatever is stuck behind it. **Price:** it changes a production ordering to solve a development
problem, and oldest-first is the correct order for money — a projection delayed longest should go
first. **Buys:** one line, no new state.

### D — Raise the bounds

**Price:** it moves the threshold without removing it, and the bound exists for a real reason. **Buys:**
nothing durable.

### E — Nothing

**Price:** the next session spends what this one spent. Two have now been spent on this queue's head,
and neither started out looking like a queue problem. **Buys:** nothing.

---

## A cleanup happened, and it is NOT option B

On 2026-09-12 the dev database crossed the bound in ordinary use — **112 stale PENDING payments
against a batch of 100** — and the local gate went red on exactly the six assertions this document
reproduces. 107 of those rows (the ones with no Transaction attached, so test residue rather than
anything a screen shows) were deleted by hand, and the gate went green again.

**That was housekeeping on one machine. It is not option B, and nothing above is decided.** The
distinction is the Founder's and it is worth stating in full, because the two are easy to conflate
six months from now:

- **The cleanup** answers *"this developer's database is over the bound today."* It is a fact about
  one machine at one moment, and it will be true again.
- **Option B** would answer *"how does the PRODUCT deal with a queue head that never moves."* That
  question is open, and it is the one that matters — a production queue has the same head, and no
  amount of local tidying reaches it.

A reader finding the cleanup in the git history and reading it as a decision would close a question
that nobody has answered. It is recorded here so that reading is not available.

## Not decided

**Trigger: the next suite failure that names the wrong thing.** Both known symptoms — a timeout in
one spec, a wrong assertion in another — point away from the cause, which is the property that makes
this expensive rather than annoying.

The first measurement, whichever option is taken: **how fast does each head grow in ordinary use?**
42 stale payments against a bound of 100 is a number without a rate, and the rate decides whether
this is urgent or merely true.
