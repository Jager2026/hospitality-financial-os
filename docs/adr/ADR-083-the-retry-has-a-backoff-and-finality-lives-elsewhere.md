---
title: ADR-083 — The retry has a backoff, and finality lives elsewhere
version: 1.0.0
status: Accepted
classification: Important
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-083 — The retry has a backoff, and finality lives elsewhere

**Status:** Accepted (Sprint 16), 2026-09-11. Two of three reported defects are fixed; **they turned
out to be one defect**, and the third is described here without being decided, by instruction.

---

## What was reported, and what it actually was

`MAX_ATTEMPTS_BEFORE_ALERT = 5` carried the comment *"repeated failure becomes an alert, not an
infinite retry loop"*. The second half was false and had been for three sprints: the constant bounds
alerting and nothing else. One e2e database was found holding an event at **5,293 attempts**, with
**4,717 ERROR lines** carrying the words *operational alert* in a single four-minute suite run
(#196).

Three defects were separated out of that observation. Investigating them collapsed the first two
into one and disqualified the framing of the second.

**1. No backoff.** Real. The interval between attempts was the poll interval — two seconds — so a
provider outage was answered by repeating the same failing call every two seconds for as long as it
lasted. That is a storm against the database and against whatever is already unwell, at the moment
it can least absorb one. **Fixed.**

**2. "No ceiling."** **Not what it looked like, and the check was worth doing before writing any
code.** Finality exists — it is `ABANDON_UNDELIVERED_AFTER_MS` (ADR-075) — and it is scoped to email
on purpose. `poll()` already said so in a comment: a journal-entry event is a money projection, and
abandoning one silently would leave a Wallet permanently wrong, so money events *"keep exactly
today behaviour — retried forever, alerted at five"*.

**So why 5,293 attempts?** Because the window is twenty-four *hours*, not a count, and at a
two-second interval **43,200 attempts fit inside it**. 5,293 attempts is about 2.9 hours — deep
inside the window, with nothing violated. The ceiling was never breached; it simply does not measure
what was growing.

**3. Expected behaviour classified as an operational alert.** Shown below, not decided.

## The two defects are one

ADR-075 recorded why it chose a window over an attempt count:

> twenty attempts is forty seconds, which would abandon real messages during an ordinary provider
> blip. Permanence is a property of elapsed time, not of how often we happened to ask.

That reasoning was correct, and it was correct **because attempts and seconds were the same quantity
at a fixed two-second interval.** The absence of a backoff is what made an attempt count useless as
a measure, which is what left a time window as the only available instrument.

With a backoff they are no longer the same quantity, and an attempt count could now be made safe.
**It still would not be the right instrument**, for the reason that survives the change: the window
is pinned to the lifetime of Resend's `Idempotency-Key`, which is a duration in the world rather
than a property of how often we ask. Past it, a retry is no longer deduplicated by the provider, so
the send stops being the same send. **No attempt ceiling was added.** The window stays exactly as
ADR-075 left it.

## The backoff

`retryDelayMs(attempts)` — 2s, 4s, 8s … doubling to a cap of **five minutes**, reached after eight
failures. The cap is chosen against recovery latency, which is the thing a person actually waits
for: five minutes after the cause is fixed, the queue drains.

| | before | after |
|---|---|---|
| attempts by a stuck event in 24h | 43,200 | **288** |
| attempts before the alert fires | 5, in 8 seconds | 5, in 30 seconds |

**A column, not a computation.** The delay depends on each row's own `attempts`, so "retry when this
row's last attempt is older than a function of this row's attempt count" is not expressible in the
poller's `findMany`. `next_attempt_at` defaults to `now()`, so an event that has never failed is
selected exactly as it was before the column existed — the backoff is invisible until something goes
wrong, which is the only time it should be visible at all.

**No jitter.** It exists to stop many clients synchronising onto one target; this poller is a single
instance draining one batch in sequence. Worth revisiting the day `poll()`'s missing claim step is
fixed and a second instance becomes possible — that is the same threshold, and `poll()`'s own
comment already names it.

## Falsification — each case rejects one specific wrong implementation

Verified by removing the implementation and confirming the test fails, then restoring it:

| removed | fails | still passes |
|---|---|---|
| the backoff | both interval tests | both finality tests |
| the ADR-075 window | the abandoned-email test | the other three |
| the email/money distinction | the money test | the email test |

The last row is the one worth keeping: **an implementation applying one ceiling to every event type
passes the email test and fails only on money**, where the damage would be a Wallet left permanently
wrong rather than an email not sent.

**One test passed for the wrong reason before it passed for the right one**, and it is recorded
because the shape recurs. `next_attempt_at` defaults to the *database's* clock, which keeps running
while `vi.useFakeTimers` holds the test process's `Date` still — so a freshly inserted row sits a few
milliseconds in the future relative to the poller's own query and is not selected at all. Two tests
failed outright. The third — *"an abandoned email is never retried"* — **passed**, because it
asserts the event is not selected, and it was not selected, for a reason with nothing to do with
ADR-075. A green assertion resting on clock skew is worse than a red one: nothing about it looks
wrong.

---

## Defect 3 — shown, not decided

**The finding.** Past the alert threshold, `logger.error` fires on **every** attempt, carrying the
words *operational alert* — the phrase reserved for something a person should wake up for. The
webhook does not: it fires exactly once per event, deliberately, and its comment says the log line
repeats "for anyone tailing logs directly". That decision is sound and is not in question here.

What is in question is the **classification**. Outside production, `EmailService.send` refuses by
construction — *"Refusing to send outside production"* — which is correct behaviour. Every email the
suite generates therefore becomes a permanently failing event, and each one eventually logs at ERROR
with the wording of an operational alert.

**The backoff changes the volume and not the semantics**, which is precisely why this stays open:
a quieter wrong classification is still a wrong classification.

### How much of the 4,717 was actually this, measured rather than claimed

The obvious sentence to write here was "the backoff removed the noise". It is false, and the
measurement that says so cost one suite run.

| e2e suite run | ERROR lines carrying *operational alert* |
|---|---|
| before ADR-082 and ADR-083 (accumulated database, no backoff) | **4,717** |
| ADR-082 truncation only, backoff removed | **7** |
| both | **0** |

**ADR-082 removed 4,710 of the 4,717.** Those lines were 132 events accumulated across earlier runs,
each re-attempted every two seconds forever; truncating the database between runs deleted the events
that were producing them. The backoff's own contribution to *this* measurement is the last 7 — the
two email events one run creates reach attempts 3 and 4 instead of about 80, staying under the
threshold of 5 entirely.

That is a small number, and it is the honest one. **The backoff's value is not visible in a
four-minute suite**; it is visible in the case the suite cannot contain — a genuinely stuck event in
production, which now costs 288 attempts a day instead of 43,200. Two changes landed near each
other and only one of them did most of the work on the symptom that prompted both. Saying which is
the whole point of measuring them apart (ADR-058).

### Options, none chosen

**A — Leave it.** The backoff already removes most of the volume. **Price:** the phrase keeps
meaning two different things, and the next person to tune alerting has to rediscover which.
**Buys:** nothing to get wrong.

**B — ERROR once, WARN thereafter.** Mirror what the webhook already does: the attempt that crosses
the threshold is the operational event; later ones are follow-ups. **Price:** someone tailing logs
for a still-stuck event now has to look at WARN. **Buys:** log level and alert level stop
disagreeing about the same moment.

**C — Rate-limit the repeat line per event.** Keep ERROR, emit at most one per event per interval.
**Price:** a second piece of state to hold, and a silent window in which a genuinely new failure
looks like the old one.

**D — Separate a refusal from a failure.** A deterministic policy refusal is not an operational
condition at all; treating it as one is what puts thousands of them in the channel. **Price:** it
needs a way for a handler to say "this will never succeed", which is a change to the dispatch
contract rather than to a log level — the largest of the four, and the only one that also gives
`poll()` a reason to stop selecting such an event. **Buys:** the distinction the other three work
around.

**The reason this is a decision and not a cleanup:** whichever is chosen changes what an
`operational alert` line means, and something downstream will eventually be wired to that meaning.
Choosing it silently is how a channel ends up with a rule nobody can state.

## What this does not close

**`poll()` still has no claim step.** Two instances would dispatch the same rows. Unchanged here and
still tracked — the backoff touches scheduling, not claiming.

**The alert threshold is still five attempts**, which is now thirty seconds rather than eight. That
is a change in when a person is paged, and it is deliberate: the attempts are the same, the waiting
between them is not.
