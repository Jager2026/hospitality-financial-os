---
title: ADR-075 — The Outbox payload outlives what it carried, and one of its two dangers expires on its own
version: 1.1.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-075 — The Outbox payload outlives what it carried, and one of its two dangers expires on its own

**Status:** Accepted (Sprint 15), 2026-09-06. **Option A, on the Founder's decision.** Options B and
C are rejected, and C is rejected on ORDER rather than on merit — the distinction is the point and
is recorded below rather than left as "not now".

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

## Decision — option A, and why the other two were refused

**A is built.** At the end of the retry window a failing email's payload is redacted with the same
shape the success path uses: `{ to, subject, text }`, body replaced. **The fact survives and the
content does not** — the event row, its type and aggregate, the recipient reachable through the
Membership the invitation belongs to, and `EmailDelivery`'s status, subject and the provider's own
error text.

**B — deleting the row — is refused on what the Outbox is for.** In the Founder's terms: the row is
the *trace of the event*, and deleting it removes the record that a message was owed and never
arrived. **Redacting the body keeps the fact and removes the content**, which is the whole
distinction B gives up. The analysis above already showed B does not even buy privacy —
`EmailDelivery.to` holds the same address one table over — so it would cost the record and keep
the exposure.

**C — a retention period — is refused on ORDER, not on merit, and that difference must not be lost.**
C is *correct*. It is also not a TTL value: it is the first retention mechanism this system would
have, and `AuditLog` cannot take a single period because nothing in the schema separates its
transaction-connected rows from its ordinary ones.

> **Building a mechanism around a table that cannot say which period applies to which row would
> hard-wire the wrong answer at the infrastructure level.**

**So the order is fixed: the schema separates the populations first, the mechanism second.**
Recorded in `IMPLEMENTATION_PLAN.md` with that precondition stated explicitly, so nobody starts at
the mechanism.

### What A actually required first: there was no permanent failure

This ADR said A was really two changes, and it was. `MAX_ATTEMPTS_BEFORE_ALERT` only alerts;
retries continued forever.

**The terminal condition is elapsed time, not an attempt count**, and the reason is arithmetic: the
poller runs every two seconds, so any attempt count large enough to be safe is a count of *seconds*
— twenty attempts is forty seconds, which would abandon real messages during an ordinary provider
blip. Permanence is a property of how long it has been, not of how often we asked.

**The window is twenty-four hours, and the number is borrowed rather than chosen.** It is the
lifetime of Resend's `Idempotency-Key` (ADR-069), and that key is the OutboxEvent id. Past it a
retry is no longer deduplicated by the provider — **the guarantee that made retrying safe has
expired**, so the send stops being the same send. That is a real boundary in the system rather than
a round number.

**Two consequences, both deliberate:**

- **The poller stops selecting abandoned email events**, which also stops one of them burning a
  batch slot forever — the documented mechanism behind the outbox specs starving.
- **Scoped to email events only.** A journal-entry event is a money projection, and abandoning one
  silently would leave a Wallet permanently wrong. Nothing here has established that giving up on
  money is ever right, so those keep exactly today's behaviour: retried forever, alerted at five.

**The one way this could have done harm, and the two locks against it.** Once a body is redacted, a
retry that still reached the transport would deliver the marker itself to a real address. The
poller excludes abandoned events, and the handler refuses to send one — asserted by a test that
fails if the transport is called at all.

### Falsification

The pair is one discriminating test split in two: **the same failing send, inside and outside the
window, must leave different rows.** A version that redacts only on success passes neither — checked
by making `abandoned` constantly false, which fails the abandonment case by name.

And the erasure sweep (ADR-052, same sprint) was extended to the shape A leaves behind. **The
strengthening is by rows rather than by count**, because that sweep enumerates *columns*: a second
Outbox row does not raise the total, so asserting `outbox_event.payload (2 rows)` is what proves the
abandoned shape is in scope, where a bigger threshold would only have looked like it did.

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
