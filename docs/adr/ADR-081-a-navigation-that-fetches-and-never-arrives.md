---
title: ADR-081 — A navigation that fetches its destination and never arrives
version: 1.0.0
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
