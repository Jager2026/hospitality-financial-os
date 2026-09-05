---
title: ADR-075 — The Outbox payload outlives what it carried, and one of its two dangers expires on its own
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-075 — The Outbox payload outlives what it carried, and one of its two dangers expires on its own

**Status:** Proposed (Sprint 15), 2026-09-06. **Three options, none chosen.** No code changes with
this ADR.

---

## The finding

`OutboxEvent.payload` for an email event holds the whole message — `to`, `subject`, and `text`. For
an invitation (ADR-070) the body contains the **raw token**.

- **On successful delivery** the body is redacted (`email-outbox.service.ts:175`), keeping `to` and
  `subject`.
- **On failure it is not redacted at all.** `attempts` increments, an alert fires at five, and the
  row is retried on every poll thereafter.
- **Nothing anywhere deletes an `OutboxEvent`** — established by searching for any delete on that
  model outside the specs, 2026-09-05, and finding none.

ADR-070 named the residue in one clause — *"an event that fails permanently keeps its body until
someone clears it"* — and there is no someone.

---

## The fact that changes the shape of it

**Measured before the options were written, because it decides which problem is being solved.**

The token is not a credential forever. `MembershipInvitationService.findMatchingInvitation` looks
up candidates with:

```ts
where: { email, acceptedAt: null, expiresAt: { gt: new Date() } }
```

`INVITATION_TTL_MS` is **seven days**. Expiry is part of the *query*, not a check applied after
finding a match, so an expired invitation is never a candidate at all — and `acceptedAt: null` does
the same for one already used. **Where the token is stored has no bearing on this.**

**So the two dangers separate, and they are not equally serious:**

| | Bounded by | Duration |
|---|---|---|
| **The token as a working credential** | the acceptance query, in code, not by any Outbox behaviour | **seven days**, then inert |
| **The recipient's address**, in `payload.to` *and inside* `payload.text` | nothing | **indefinite** |

**The scary half is bounded and the boring half is not.** The remaining problem after seven days is
retention of personal data, not a live credential — a smaller thing than "a working token forever",
and a real one.

**Two qualifications, so this is not read as an all-clear.** Within those seven days the exposure is
genuine: an undelivered invitation's token sits in a table, usable by anyone who can read it. And
the seven-day bound is a property of one caller — a second consumer that puts a longer-lived secret
in a payload inherits none of it.

**One thing already changed** (the erasure fix, same day): an erasure request now rewrites `to` and
`text` for that person. That covers people who *ask*. It does nothing for anyone who does not.

---

## Option A — redact the body on permanent failure

Mirror the success path: once an event is permanently failed, replace `text` as delivery already
does.

**Cost, and it is larger than it sounds: there is no such thing as permanent failure today.**
`MAX_ATTEMPTS_BEFORE_ALERT = 5` only *alerts*; retries continue forever, which is why the debris in
the development database has `attempts` in the hundreds. So this option is really two:

1. **Invent a terminal state** — a status, or a threshold above which the poller stops. That is a
   change to the Outbox's delivery contract and needs its own reasoning: a row that stops being
   retried is a message deliberately abandoned, and today nothing abandons anything.
2. Then redact on entering it.

**What it buys:** the body stops existing at a defined moment, and the poller stops burning a batch
slot on a row that will never publish — which is also the mechanism behind the test-suite
starvation `IMPLEMENTATION_PLAN.md` records.

**What it does not buy:** `to` still remains, so the personal-data half is untouched.

---

## Option B — delete the row

**Cost:** the Outbox's value is that it records what was *supposed* to happen. Deleting a failed
event removes the evidence that a message was owed and never sent, which is the one case anybody
would want to look up.

**Softened by a fact:** `EmailDelivery` keeps `to`, `subject`, `status` and `lastError` for the same
message, so deleting the `OutboxEvent` does not erase the incident — it erases the *payload* and
keeps the record. That makes B less destructive than it first reads.

**Undercut by another:** `EmailDelivery.to` is the recipient's address, retained indefinitely too.
**Deleting the Outbox row moves the personal data, it does not remove it.** Any option that treats
`OutboxEvent` alone will leave the same address one table over.

**And it needs the same terminal state A does** — you cannot delete on failure without defining
which failure is final.

---

## Option C — a retention period for `OutboxEvent`

Rows older than N days are removed, failed or not.

**This is not "add a TTL", and calling it that is how it gets underestimated. There is no retention
mechanism in this system at all.** Established by searching, 2026-09-06:

- **No scheduled deletion of any row, anywhere.** Three `@Interval` jobs exist — the Outbox poller,
  payment reconciliation, and the shift auto-close sweep — and not one of them deletes anything.
- The only TTL constant in the codebase is `KEY_TTL_MS` for idempotency keys.
- `PERSONAL_DATA_MAP.md` §6 records that the *periods* are decided — ten years for
  transaction-connected data, the general contract rule otherwise — and that **`AuditLog` alone
  cannot take a single period**, because it mixes transaction-connected rows with ordinary ones and
  nothing in the schema distinguishes them.

**So C is the first instance of a mechanism this product will need regardless**, and picking it here
means building that mechanism for the easiest table first rather than deciding it for `AuditLog`
under pressure later. That is an argument *for* it, not against — but it should be chosen with its
size known, not as a config value.

**What it buys that A and B do not:** it is the only option that bounds the **address**, which after
seven days is the whole remaining problem, and the only one whose shape extends to `EmailDelivery`
and `AuditLog`.

---

## What is not an option

**Leaving it and relying on the erasure path.** That covers only people who ask to be erased, and
the population most affected — invited staff whose invitation failed — are the least likely to know
there is anything to ask about.

---

## Recommendation, offered rather than taken

**C is the one that solves the problem that remains after seven days**, and A is the one that solves
the sharper, shorter one — they are not alternatives so much as different deadlines. If both are
eventually wanted, **A is cheaper to do first only if the terminal state is wanted anyway** (it is,
for the batch-starvation reason), and **C is the one that must not be quietly deferred**, because
the same missing mechanism is already blocking `AuditLog` and `EmailDelivery`.

**Trigger, if none is chosen now: before the first venue onboards staff.** That is the moment
invitations start failing against real addresses, and it is already the trigger on the consent gap
(ADR-070), so the two arrive together.
