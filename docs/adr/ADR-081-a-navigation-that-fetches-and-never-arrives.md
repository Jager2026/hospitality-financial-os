---
title: ADR-081 — A navigation that fetches its destination and never arrives
version: 1.1.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-081 — A navigation that fetches its destination and never arrives

**Status:** Proposed (Sprint 16), 2026-09-10. **The cause is NOT established, and this document
says so as its headline rather than in a footnote.** What it does contain is a precise
characterisation of the failure from a captured trace, three hypotheses refuted by measurement, and
workaround options — none chosen.

**Stopped deliberately.** This is the fourth session on this flake. Diagnosis without end is worse
than an honest "not established", and the Founder set that boundary explicitly.

**Why it is urgent rather than interesting.** `browser-e2e` became a required check on 2026-09-09
(OC-3). A failure of this shape blocks **every** pull request in the repository, including the ones
that have nothing to do with it. It has already blocked one.

---

## What is failing

An assertion of the form *click a `Link`, expect the URL to change*. Observed on three tests going
to three different routes:

| test | destination |
|---|---|
| `transactions.spec.ts:217` | `/restaurants/{id}/transactions` |
| `transactions.spec.ts:185` | `/restaurants/{id}/transactions/{transactionId}` |
| `connect-payments.spec.ts:226` | `/restaurants/{id}/onboarding` |

It appears on branches that touch those screens and on branches that do not; the earliest recorded
instance predates the Dashboard's Staff and Settings links. It is load-dependent — roughly one suite
run in twenty on a busy machine, and it has reached CI once.

## What the trace shows

The failure was reproduced deliberately, to capture evidence rather than to get a green run, and
Playwright's trace was kept.

- **The click landed on the right element.** `locator resolved to <a data-testid="dashboard-transactions-link" href="…/transactions">`, then *"element is visible, enabled and stable"*, *"performing click action"*, *"click action done"* — 186 ms, no error.
- **Playwright saw no scheduled navigation.** The element is a real `<a href>`, so its default was prevented; only React does that here. The `Link` handler ran and the router took the push.
- **The destination was fetched and arrived.** `…/transactions?_rsc=f9Vn2UbyevoV6c1u` → **200, 1,168 bytes, 11 ms**.
- **The URL never changed**, across 33 polls over the full 15 seconds.

**The router accepted the push, requested the new route's payload, received it in eleven
milliseconds, and never committed.**

`playwright.config.ts` predicted this in writing: a test that stably needs a longer timeout is *"a
finding about the product, not a reason to raise it again"*. Fifteen seconds is not close, and no
number is right when the answer is that the navigation never happens.

## Three hypotheses, refuted by measurement

**1. The click lands before hydration.** Refuted twice, and by construction rather than by a lucky
run. `dashboard-view.tsx` is a `"use client"` component whose link renders inside a `useQuery`
branch behind `RequireSession`: loaded with JavaScript disabled, the server HTML (7,629 bytes) does
**not contain the link at all**. A click cannot precede the hydration that creates the thing being
clicked. And React's own `__reactFiber$…` marker was present on the node at every observed click,
failing and passing alike.

**2. The click path is CPU-bound.** Refuted. With a 10× CPU throttle applied *at the moment of the
click* — after render and hydration, so the page is real — navigation completed in **606–873 ms**
across three runs, against 82–163 ms unthrottled. A first version of this probe throttled 20× from
the start and never reached its own measurement, because the link never appeared; that failure was
the first half of refutation 1.

**3. An aborted prefetch poisons the navigation.** This one deserved its own experiment, because the
trace shows the shape recorded in **#174** and closed then as unreproducible: the router's prefetch
requests for both destinations came back **200 with `bodySize: -1` and `net::ERR_ABORTED`**, while
the navigation fetch that followed completed normally. Payload in hand, no commit — so the
hypothesis was that the aborted prefetch leaves an entry in the App Router cache which never
settles, and the navigation awaits it instead of the fetch that succeeded.

**Tested by forcing the abort rather than waiting for it** — a real failure once in twenty runs is
useless for comparing two arms — with the first prefetch of the destination aborted deliberately and
every later request let through:

```
control 1: aborted=0  navigated=149ms       treated 1: aborted=1  navigated=319ms
control 2: aborted=0  navigated=96ms        treated 2: aborted=1  navigated=577ms
control 3: aborted=0  navigated=97ms        treated 3: aborted=1  navigated=469ms
```

**Refuted.** Aborting the prefetch makes the navigation slower — the router has to go and get it —
and it still arrives, every time. So the `bodySize: -1` shape is **present but not causal**, which
also settles #174's open question in the negative rather than leaving it to be re-opened a third
time.

## Answers to the two leads that prompted this session

**The payload is requested twice because it is a prefetch and then a navigation, not two
navigations.** Established from the `_rsc` hashes: the prefetch batch shares one hash across every
link in the viewport (`/restaurants`, `/onboarding`, `/transactions` all carry `zXpy8wvHVSVj6uCt`),
while the navigation carries its own (`f9Vn2UbyevoV6c1u`). The router does not discard both — the
second one completes.

**It is the same shape as #174, and that turned out to be the wrong thread.** Same `bodySize: -1`,
same class of transition, and — measured above — not the cause. Worth recording precisely because
the resemblance is strong enough that somebody will follow it again.

## What has NOT been established

**The mechanism between "payload arrived" and "commit that never came".** Candidates not yet taken
to a probe, in the order they seem worth trying:

1. **A render during the transition.** App Router commits inside a React transition; a concurrent
   re-render on the page being left — the Dashboard runs TanStack queries that refetch — could
   restart or drop it. This fits the load dependence best and is where the next session should start.
2. **The destination suspending.** The target renders `RequireSession` and its own `useQuery`; a
   suspend without a boundary in the new tree would hold the URL.
3. **`authed-fetch`'s refresh path racing the transition** — a token refresh in flight when the
   navigation begins.

**Whether a real person is affected.** Every observation comes from Playwright. The probe never
reproduced the hang in isolation, so it never got to answer whether a **second click recovers** —
which is the question that decides whether this is a test-only annoyance or a defect a customer
meets on a slow phone. **It is the cheapest next measurement and it should be first.**

---

## Options — for unblocking the required check, none chosen

Two remedies are excluded before the list starts, by rules this repository already holds: **raising
the timeout** (`playwright.config.ts`: a stable need for more time is a finding about the product)
and **re-running until green** (`CLAUDE.md`: "ran twice, green" is not a diagnosis).

### A — Quarantine the three assertions by name

Keep running them, report their result, and stop them failing the required check.

**Price:** a list somebody edits to go green — the rubber-stamp decay `CLAUDE.md` names, and this
project has watched it happen twice. It would need a bound that is not a promise: an expiry date, or
a check that refuses a list longer than N, or a link to this ADR that CI verifies still says
`Proposed`. **Buys:** other people's pull requests stop being blocked tomorrow.

### B — Split the job: deterministic suite required, navigation assertions advisory

Move the click-then-navigate assertions into a second Playwright project that runs and reports but
is not required.

**Price:** two jobs to keep in step, and the boundary between them rots the moment somebody adds a
navigation assertion to the required half without noticing. It is also exactly the shape ADR-073
warned about — a check that reports but blocks nothing reads as green. **Buys:** the distinction is
visible in the workflow file rather than in a list of test names.

### C — Assert the destination's content instead of the URL

**Price:** weaker everywhere, and it would pass while the URL stayed wrong — which is the actual
defect. Recorded to be rejected explicitly rather than rediscovered.

### D — One bounded retry of the click, counted and reported

If the URL has not changed within N seconds, click once more, and **fail the test if the retry was
needed more than K times across the suite** — so the flake becomes a measured rate rather than an
intermittent stoppage.

**Price:** it is a re-run in miniature, and the rule against re-running exists because a re-run
destroys the state in which the cause could be seen. It would need to keep the trace of the first
attempt to be honest. **Buys:** the only option that turns the defect into a number, which is what
a future fix would be measured against.

### E — Nothing

**Price:** a required check fails at random for every pull request in the repository, and the next
person to meet it will spend a session on it, as three sessions already have. **Buys:** nothing.

---

## Not decided

**Trigger: the next pull request this blocks.** On present frequency that is days, not weeks — and
whichever option is chosen, the measurement named above under *"whether a real person is affected"*
should happen first, because it costs one probe and it changes what this document is about.

---

## Amendment — the second-click measurement was attempted, and did not reproduce

**2026-09-11, Sprint 16, fifth session. The question is still unanswered**, and this section says so
first, because the section directly above calls it "the cheapest next measurement and it should be
first". It was taken first. The failure did not happen.

### What was run

The three assertions in the table above were instrumented in place, rather than in a probe: the
previous session established that the hang has never reproduced outside a full suite run, so a
standalone probe measures the wrong thing. `apps/e2e/fixtures/navigation-measure.ts` clicks, waits
the same fifteen seconds the `toHaveURL` assertion waited, and — only once that has already failed —
clicks a second time and reports what happened.

| attempts | shape | reproductions |
|---|---|---|
| 100 | standalone probe, warm context (session four) | 0 |
| 60 | standalone probe, cold context per attempt (session four) | 0 |
| **60** | **full `test:e2e` runs, instrumented assertions (this session)** | **0** |

Sixty full-suite runs, about three hours. One of the sixty failed on something else — a
`POST /auth/register` that hung until the thirty-second test timeout — and its log, trace and
screenshot are kept, because a cause is isolable exactly once. It is not this flake: no navigation
was involved.

### What zero means, and what it does not

**Thirteen runs would have been worthless and were nearly reported as a result.** At the rate this
document records — roughly one suite run in twenty — the probability of seeing nothing in thirteen
runs is 51%. A coin toss is not a finding, and "ran thirteen times, green" is the same sentence as
the one `CLAUDE.md` forbids, with a larger number in it. The budget was extended for that reason and
for no other.

At sixty runs the probability of zero, if the recorded rate were true, is **4.6%**. So one of two
things holds: the rate on this machine is below one in twenty, or this was an unlucky sample at the
5% level. **What is NOT established is that the defect is gone** — it was captured on a trace, and a
trace is not undone by a later silence.

### Why this negative may not transfer to CI

Three conditions differ from the ones that produced the original failure, and all three are recorded
rather than argued:

1. **The e2e database is never reset.** `prepare-database.ts` creates, migrates and seeds; it does
   not truncate. After these runs it holds **5,233 users** and **132 outbox events that have never
   published**, the oldest at **5,293 delivery attempts**. CI starts empty every time. Sixty runs on
   a monotonically growing database is not sixty repetitions of CI's condition.
2. **The machine was mostly idle.** Runs took 2.1 minutes for the first seven and 3.6-4.3 for the
   rest. This document records the failure as load-dependent.
3. **It has reached CI once.** So the conditions that produce it exist somewhere this session could
   not reach.

### The instrument is left armed, and what that costs

It stays in the three assertions. The reasoning is that the answer cannot be obtained locally — that
is now measured, not assumed — so the only remaining route to it is the next real failure, wherever
that happens. An instrument that is not armed when the failure comes has to wait for the one after.

**It cannot turn a red run green.** The first wait is fifteen seconds, exactly the `expect` timeout
of the assertion it replaces, so the first click is judged by the same standard as before; a test
that failed still fails. The only difference is that the failure message carries
`secondClickNavigated=yes|no` instead of only the symptom.

### The instrument's own defect, found before it could mislead

The first version could not have reported at all. Its waits summed to 47 seconds against a test
budget of 30, so Playwright would have killed the test with `Test timeout of 30000ms exceeded` and
the measurement would never have printed — and the run would have looked exactly like the flake it
was there to explain. It is the failure mode `CLAUDE.md` names for self-written tools, in its
quietest form: not a false finding, but no finding, wearing the same face as the symptom.

Fixed by shortening the measurement windows and raising the test timeout **only on the path where
the test has already failed**, so a passing run is untouched and no raise can ever buy a green
result. Verified as a discriminating pair rather than by reading it:

- **must stay silent:** 59 clean full-suite runs, 68 passed each, not one measurement line;
- **must report:** one run with the target regex deliberately made unmatchable — the measurement
  printed in full, and the failing path took **29.0 seconds** against the 30-second default, on an
  idle machine running a single test. A one-second margin is why the raise is necessary rather than
  precautionary.

**Still unexercised: the `secondClickNavigated=yes` branch.** No case has been constructed in which
a first click genuinely fails and a second genuinely succeeds, so that half of the report has never
run. Said plainly because the whole point of the instrument is that branch.
