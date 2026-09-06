---
title: ADR-076 — The Portal does not refresh a token yet, and the cheaper option is the one with a race
version: 1.0.0
status: Proposed
classification: Critical
owner: Founder
technical_owner: AI Technical Co-Founder
---

# ADR-076 — The Portal does not refresh a token yet, and the cheaper option is the one with a race

**Status:** Proposed (Sprint 15), 2026-09-06. **Two options, neither chosen.** The Dashboard slice
ships without either; what it does instead is stated below and is deliberately not one of them.

---

## The state, established by reading both sides

**The backend already has the whole mechanism.** `POST /auth/refresh` rotates: every refresh token
carries a `familyId` generated once at login and carried unchanged through every rotation descended
from it, so replaying an already-rotated token is *detected* and revokes the family
(`token.service.ts`, audited as `refresh_token_reuse_detected`).

**The frontend does not contain the word.** No call, no interceptor, no timer. `JWT_ACCESS_TTL_SECONDS`
defaults to **900 seconds**, so fifteen minutes after signing in every request starts failing, and
today the Dashboard shows its "we could not load this" state and stays there. A person whose token
expired sees a broken screen and has no way to learn that signing in again would fix it.

**What this slice does instead, and why it is not a third option:** a 401 or 403 is no longer
retried (TanStack retries three times by default, which is right for a dropped connection and
pointless for an authorization decision). That makes the failure *arrive promptly*. It does not make
it *correct*.

---

## Option A — silent refresh on 401

The API layer catches a 401, calls `POST /auth/refresh` once, stores the rotated pair, and replays
the original request. The person notices nothing.

**The cost is a race, and it is not hypothetical on this screen.** The Dashboard issues **two**
requests at once (ADR-063 — figures from our Ledger, the payout banner from Stripe's cached status).
When the token expires, both fail, and both try to refresh.

**Why that is worse than a wasted call: rotation makes the second one a security event.** The first
refresh rotates the token and invalidates the one the second request is still holding. The second
then presents a rotated-out token — which is exactly the signature of a stolen token being replayed,
so the backend revokes **the entire family** and signs the person out of every session they have.

> **The naive implementation does not merely duplicate work. It converts an ordinary expiry into a
> forced global logout, and it does so more reliably the more the screen fetches in parallel.**

**So A is really A-plus-a-mechanism:** a single-flight guard — one in-flight refresh promise that
every waiting request awaits, rather than each starting its own. That is a small amount of code and
a specific amount of care: it must be shared across the whole app rather than per hook, it must
survive the refresh itself failing (every waiter has to be rejected, not left hanging), and it needs
a test that runs two expired requests concurrently and asserts **exactly one** refresh call. Without
that test the guard looks identical to the naive version on every screen that fetches once.

**What A buys:** the fifteen-minute session stops being visible. For a screen an owner leaves open
on a counter all day, that is the difference between a product and a demo.

---

## Option B — bounce to Log In

A 401 clears the session and redirects, with a message saying the session ended.

**Cost:** the person loses what they were doing every fifteen minutes of inactivity, which on a
Dashboard is nothing and on a form would be their typing. **What it buys is that there is no race to
get wrong** — no shared state, no single-flight, no concurrent-refresh test, and no path by which a
bug signs somebody out of every device instead of one.

**And it is not merely the lesser option.** It is honest: the session really has ended, and the
screen says so. A silent refresh that fails silently is the shape this project keeps recording —
something that looks like it worked.

---

## What is not an option

**Leaving it as it is.** The failure today is indistinguishable from the server being down, so the
one thing the person can do about it — sign in again — is the one thing the screen does not suggest.
Whichever of A or B is chosen, the wording of that state changes with it.

---

## The order worth noting

**B is a subset of A's error handling.** A still needs a terminal case for when the refresh itself
fails, and that case *is* B. So building B first is not work thrown away when A arrives — it is the
half of A that has to exist either way.

**Trigger, if neither is chosen now: before the first pilot restaurant.** The same trigger the
cookie-session move already carries (`IMPLEMENTATION_PLAN.md`), and for the same reason — both are
about a real person keeping a real session, and both stop being theoretical on the same day.
