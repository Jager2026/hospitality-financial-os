# e2e fixtures — read this before adding one

Two rules, both learned from real near-misses rather than invented.

## 1. Never flush Redis. Delete by prefix.

The e2e suite needs to clear rate-limit state between tests. The obvious way to do that is
`FLUSHALL` or `FLUSHDB`, and it would be a security bug.

**Token revocation lives in the same Redis, under `auth:`** (`token.service.ts`) — every
logged-out session and every token family revoked on refresh-token reuse detection. A blanket
flush would un-revoke all of it. Nothing would fail. The suite would go green while the test
infrastructure quietly switched off a protection this project decided on in ADR-019.

That is the worst shape of defect available here: **test infrastructure disabling a security
control, silently, in the one place nobody thinks to review for security.** And the habit is
learned in tests before it is applied somewhere it matters.

So: rate-limit state is written under `throttle:` (ADR-042), and `resetRateLimits()` in
[`throttle.ts`](./throttle.ts) scans that prefix and deletes only those keys. Use it. If you need
to clear something else, add another prefix-scoped helper next to it.

**This is enforced, not requested.** `tests/fixture-safety.spec.ts` fails if `flushall` or
`flushdb` appears anywhere under `apps/e2e`. A rule you can break without noticing is weaker than
one you cannot break — the same reasoning that left `--warning` out of the design tokens
entirely (`DESIGN_SYSTEM.md`) rather than relying on the discipline not to use it.

## 2. Create data through the real API, not by inserting rows.

`registerUser()` in [`api.ts`](./api.ts) calls the real `POST /auth/register`. It would be faster
to insert a `user` row directly — and the resulting test would be worthless.

A row inserted by a fixture carries a hash that fixture computed, at a cost factor it chose,
skipping every validation the endpoint performs. A login test built on it proves that our two
helpers agree with each other, **not** that registration and login agree. The bug where they
disagree is exactly the bug the test exists to catch.

Same rule for anything else with a real endpoint behind it. Insert directly only when there is no
endpoint at all, and say so in a comment when you do.

## The budget you are spending

`AuthController` is limited to 10 requests per minute **per route, per caller IP** — the throttler
key includes the handler name, so `login` and `register` have separate buckets (this was
originally documented the other way round; the test caught it, see ADR-042).

Tests that do not need many auth calls should not make them. `harness.spec.ts` deliberately
spends three. If your fixture needs a fresh budget, call `resetRateLimits()` — never raise the
limit for tests, which would weaken the exact behaviour under test.
