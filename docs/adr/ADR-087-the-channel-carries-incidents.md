---
title: ADR-087 — The channel carries incidents
version: 1.0.0
status: Accepted
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-087 — The channel carries incidents

**Status:** Accepted (Sprint 16), 2026-09-13. Decides the question
[ADR-083](ADR-083-the-retry-has-a-backoff-and-finality-lives-elsewhere.md) left open with four
options and none chosen: **what the phrase *operational alert* means.**

---

## Why now rather than when it hurts

Because it will not announce itself when it starts hurting. Today the alert channel is quiet
because there is no traffic; the arithmetic for the first restaurant is already on the table.

> Two hundred covers in an evening. A tenth of them abandoned or declined — a guest who walks away,
> a card the issuer refuses. **Twenty alerts a shift**, every one of them about a payment that
> simply was not made.

A week of that and a genuine Outbox Lag alert arrives in a channel nobody reads. This is
`CLAUDE.md`'s rubber-stamp decay reached through volume rather than through an allow list, and the
distinguishing property is that **it degrades on its own**: nobody decides to stop reading, the
signal-to-noise ratio decides for them.

The second source is smaller but older. Outside production `EmailService` refuses to send by
construction, and that refusal counted as a dispatch failure, was retried to five attempts, and then
announced itself as an incident. ADR-083 measured **4,717 ERROR lines carrying the words
*operational alert* in a single four-minute suite run**.

---

## The decision

**The channel carries incidents. Expected outcomes are recorded and not announced — and which is
which is decided by the CAUSE, at the place that knows it.**

That is ADR-083's **option D**, and it is now much cheaper than it was when it was written. The
other three:

- **A, leave it.** Refused. The phrase keeps meaning two different things and the next person to
  tune alerting rediscovers which.
- **B, ERROR once and WARN thereafter.** **Taken, but as a consequence rather than as the
  decision.** Once the channel carries incidents, the log level has to agree with it: the line that
  says *operational alert* now appears on the poll that actually sends one, and a still-failing
  event afterwards reports at WARN with its attempt count. That is what somebody tailing logs
  actually needs, and it is derived from D rather than chosen instead of it.
- **C, rate-limit the repeat line.** Refused, and not only for its stated price (a second piece of
  state, a silent window where a new failure looks like the old one). It treats the symptom: a
  rate-limited stream of expected behaviour is still expected behaviour in an incident channel,
  just less of it.

### D was re-costed rather than assumed, and it is roughly a third of what it was

ADR-083 called D *"the largest of the four"* because it needed a way for a handler to say "this will
never succeed" — a change to the dispatch contract. **[ADR-085](ADR-085-a-queue-with-only-one-exit.md)
built exactly that**, for a different reason, arriving from ADR-084's side. So the remaining work
was not a new contract:

| what D needed | state before this change |
|---|---|
| a handler can say "this can never succeed" | **built** — `PermanentRejection` |
| `poll()` stops selecting such an event | **built** — `abandoned_at` |
| a handler can say "…and this is not an incident" | one readonly field and a factory |
| the alert sites read it instead of guessing | three call sites |

The measured cost was one field on an existing class, one new throw site, three call sites and two
log-level changes. **The estimate that made D look expensive was correct when written and was not
re-checked against what had since been built** — which is the general lesson worth more than this
instance: a deferred option's price is not a constant, and the thing that makes it cheaper is
usually work done for another reason.

---

## The mechanism: two independent questions, answered where each is knowable

`PermanentRejection` now carries both:

1. **Conclude or keep retrying?** (ADR-085.) *Would concluding this row lose work that actually
   happened?*
2. **Should a person be told?** (Here.) *Is this something going wrong, or the system doing what it
   was built to do?*

They are genuinely independent, and conflating them is the defect:

| case | conclude? | incident? |
|---|---|---|
| outbox payload with no valid `journalEntryId` | yes | **yes** — the product cannot produce one, so its existence means something upstream is wrong |
| `EmailService` refusing outside production | yes | **no** — this is the design working |
| Stripe PaymentIntent Stripe has never heard of | yes | **yes** — our records and the processor's have diverged |
| Stripe reports the intent `canceled` | yes | **no** — a payment that did not happen is how most payments that do not happen end |
| Resend returning 500 | no (transient) | **yes**, at the threshold |
| a guest who has not paid yet | no | **no** |

**The classification is made at the throw site and read at the alert site, never re-derived there.**
The place that observes a failure cannot know why it happened; deciding from the outcome is exactly
what made a policy refusal and a provider outage indistinguishable. `EmailService` used to throw
`EmailSendError` for both — its own docstring said the narrower thing (*"Thrown when Resend did not
accept the message"*) while the code did otherwise.

**The default is incident.** ADR-085's default is *retry*; these point in opposite directions on
purpose, and both err toward not losing information. A cause nobody has classified should keep being
retried rather than be silently dropped, **and** it should reach a person rather than vanish.
Expectedness has to be claimed, by an author who knows why.

---

## Cause, not environment — the falsification that mattered most

The Founder's condition: *if the answer reduces to "outside production we stay quiet", it does not
solve the problem, it hides it until the first restaurant.*

It does not reduce to that, and the check is structural rather than a promise:

- **Nothing in the alert path reads `NODE_ENV`.** `abandon()` reads `rejection.isIncident`;
  `conclude()` is told by its caller. Neither knows what environment it is in.
- **The environment is the CAUSE of one refusal, not the classification.** What gets recorded is
  *"we refused by policy"* — which would be just as expected if the policy were a per-restaurant
  suppression in production.
- **A real Resend outage in a development environment still alerts**, because it is a different
  cause.
- **The production case is the one that changes most.** Twenty alerts a shift becomes zero, decided
  by what Stripe answered and not by where the code is running. If this had been keyed on
  environment, that number would have stayed twenty.

The tests are built to prove this rather than assert it: `OutboxPollerService alert semantics
(ADR-087)` runs **three causes in one environment**, changing nothing but why the send failed.

---

## Falsification

Each mechanism was removed and the right test watched to fail.

| removed | test that failed | with |
|---|---|---|
| `abandon()` reads `isIncident` → alerts always | EXPECTED: a policy refusal … raises no alert | *expected behaviour raised an operational alert* |
| `conclude()` reads its caller → alerts always | a CANCELED PaymentIntent is concluded and NOT alerted | *a guest who walked away raised an operational alert — twenty of these is one evening* |
| the head-pressure edge trigger → alerts every cycle | a saturated head alerts ONCE … and not again | *the same standing condition was announced twice* |

And the two halves that must **not** move, both of which stayed green under every neutralisation
above:

- **A provider failure still alerts.** `PROVIDER FAILURE: a real outage is not concluded and still
  reaches the channel at the threshold` — in the same environment as the silent case, which is what
  makes the distinction one of cause.
- **`resource_missing` still alerts.** It concludes the Payment through the identical `conclude()`
  call as `canceled` and reaches the channel, which is the pair that rejects "concluding is quiet".

At the source, one more pair: the refusal is a `PermanentRejection` with `isIncident === false` and
**not** an `EmailSendError`; a 500 from Resend is an `EmailSendError` and **not** a
`PermanentRejection`. An implementation throwing one type for both passes each test's first
assertion and fails its second.

---

## What was removed, and what replaced it

**A signal was removed on purpose, and leaving it at that would have been the worse defect.** The
per-payment alert about an abandoned checkout was noise, but it was also — accidentally — the only
evidence that stuck payments were piling up at the head of the reconciliation batch. Removing a
signal without replacing it is how ADR-045's invisible restart loop happens.

So `PaymentReconciliationService` gained **one alert about the condition**: when the batch comes back
full, the oldest `BATCH_SIZE` payments fill the window and **nothing newer is being checked against
Stripe at all**. That is the ADR-084 failure arriving in production, it is operational in the strict
sense, and it fires once per occurrence rather than once per row.

It is edge-triggered from memory, with one consequence stated rather than discovered: **a restart
re-announces a condition that is still true.** That is correct rather than a bug — a new process has
reported nothing yet, and a standing problem nobody has been told about is worse than one mentioned
twice.

---

## What this does NOT fix

- **The work does not stop, only the noise.** A payment at `requires_payment_method` is still
  retrieved from Stripe every five minutes, forever. At twenty abandoned checkouts a shift that is
  roughly **5,760 Stripe calls a day and growing**. Ending it needs ADR-085's cancellation window,
  which is open with its own trigger: the first venue carrying real traffic.
- **`processing` has no rule of its own.** A card intent does not sit in it for long, so a payment
  that does is arguably worth knowing about — but what "too long" means cannot be established at
  zero traffic, and inventing the number is the mistake the cancellation window is deliberately not
  making. It is silent today, with this written down.
- **The outbox has no head-pressure alert**, and the asymmetry is deliberate: nothing was removed
  there. A transient failure still alerts at five attempts, so no condition became invisible. If
  the outbox ever needs one, it is the same fifteen lines.
