import { expect, test } from "@playwright/test";
import { API_BASE, login, registerUser, type SeededUser } from "../fixtures/api";
import { resetRateLimits } from "../fixtures/throttle";

/**
 * The rate limit, tested on its own budget — which only became possible with ADR-042.
 *
 * `API_Contract.md` documents "Authentication 10/min", and `IMPLEMENTATION_PLAN.md`'s Sprint 2
 * Definition of Done says "a brute-force attempt is throttled". Until now that was proved by an
 * integration test that boots a Nest module with the real controller, which is real but not the
 * whole claim: it does not exercise the deployed process, its Redis, or the limit surviving
 * anything outside one module's lifetime.
 *
 * Every test in this file resets throttle state first — real throttler, real Redis, real limit,
 * only the counter cleared. Raising the limit for tests was rejected: a check that has been
 * quietly relaxed is worse than one that does not exist.
 */

let user: SeededUser;

test.beforeAll(async ({ request }) => {
  await resetRateLimits();
  user = await registerUser(request);
});

test.beforeEach(async () => {
  await resetRateLimits();
});

test("the eleventh authentication request in a minute is rejected", async ({ request }) => {
  // Ten wrong-password attempts are allowed and answered honestly — 401, not 429. Asserting that
  // matters as much as the block itself: a guard that returned 429 early would "pass" a test that
  // only checked the eleventh call, while actually breaking login for legitimate users.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await login(request, user.email, `${user.password}-wrong-${attempt}`);
    expect(response.status(), `attempt ${attempt} should be a normal rejection`).toBe(401);
  }

  const blocked = await login(request, user.email, `${user.password}-wrong-11`);
  expect(blocked.status()).toBe(429);
});

test("the limit blocks the correct password too — it is a brute-force ceiling, not a wrong-password counter", async ({
  request,
}) => {
  // The discriminating half. An implementation that counted only *failures* would pass the test
  // above and leave the real attack unthrottled: an attacker who guesses correctly on attempt
  // three has already won, and one who sprays a list of common passwords across many accounts is
  // never counted at all. The limit has to be on requests.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    await login(request, user.email, `${user.password}-wrong-${attempt}`);
  }

  const correctButBlocked = await login(request, user.email, user.password);
  expect(correctButBlocked.status()).toBe(429);
});

test("each auth route carries its own budget — exhausting login does not lock out registration", async ({
  request,
}) => {
  // This test was written asserting the opposite, from the reasonable-looking assumption that a
  // controller-level `@Throttle` means a controller-level budget. It does not. `ThrottlerGuard`
  // builds its key as `sha256(ClassName-handlerName-throttlerName-tracker)`, so the HANDLER is
  // part of the key and every route gets its own bucket even under one decorator. The assumption
  // was wrong and this test is what caught it — which is the argument for asserting behaviour
  // rather than describing it.
  //
  // Worth keeping rather than deleting: if a custom `generateKey` is ever added and drops the
  // handler, every auth route would silently collapse into a single shared bucket, and one
  // brute-force attempt would start locking legitimate users out of registration.
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    await login(request, user.email, `${user.password}-wrong-${attempt}`);
  }
  // Login is now blocked...
  expect((await login(request, user.email, user.password)).status()).toBe(429);

  // ...and registration, a different handler, is not.
  const response = await request.post(`${API_BASE}/api/v1/auth/register`, {
    data: {
      email: `e2e-budget-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: `e2e-budget-${Math.random().toString(36).slice(2)}-Aa1!`,
      displayName: "Budget Probe",
    },
  });
  expect(response.status()).toBe(201);
});

test("clearing throttle state does not clear anything else — the fixture is targeted", async ({
  request,
}) => {
  // The fixture deletes `throttle:*` and nothing else. If it ever became a blanket flush, token
  // revocation would go with it — silently, and only in tests, which is where the habit would be
  // learned before being applied somewhere it matters.
  //
  // Proved through behaviour rather than by reading Redis: log in, log out (which revokes the
  // session), reset throttle state, and confirm the revoked token is still refused.
  const session = await login(request, user.email, user.password);
  expect(session.status()).toBe(200);
  const body = (await session.json()) as {
    data: { accessToken: string; refreshToken: string };
  };

  const loggedOut = await request.post(`${API_BASE}/api/v1/auth/logout`, {
    data: { refreshToken: body.data.refreshToken },
    headers: { Authorization: `Bearer ${body.data.accessToken}` },
  });
  expect(loggedOut.ok()).toBeTruthy();

  await resetRateLimits();

  const replayed = await request.post(`${API_BASE}/api/v1/auth/refresh`, {
    data: { refreshToken: body.data.refreshToken },
  });
  expect(replayed.status(), "a revoked refresh token must stay revoked").toBe(401);
});
