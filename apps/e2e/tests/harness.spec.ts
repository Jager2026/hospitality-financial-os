import { expect, test } from "@playwright/test";
import { API_BASE, login, registerUser, type SeededUser } from "../fixtures/api";
import { queryOne } from "../fixtures/db";

/**
 * Proves the harness itself, before any screen relies on it.
 *
 * Same principle as transcribing the token layer in full before its first consumer: verification
 * infrastructure shaped by the screen it was written for ends up testing what that screen happens
 * to do. Each test below asserts one link in the chain the harness claims — real browser, real
 * Next.js, real NestJS, real Postgres, real bcrypt — so a broken link is reported as a broken
 * harness rather than as a broken feature months from now.
 *
 * ── The auth-request budget, and why this file is deliberately frugal ──────────────────────────
 *
 * `AuthController` carries `@Throttle({ limit: 10, ttl: 60_000 })` at the CONTROLLER level, so
 * register, login, refresh, logout and me all share **one 10-per-minute budget**, and the default
 * tracker keys on the request IP — which is the same for every test here. The counter lives in
 * `@nestjs/throttler`'s in-memory store (no storage provider is configured; ADR-028 Decision 5
 * already recorded that "ThrottlerGuard's in-memory counter lives per app instance"), so it
 * cannot be reset from outside the backend process.
 *
 * This file therefore spends exactly **three** auth requests in total: one register, one correct
 * login, one wrong-password login. That is a real constraint, not a style choice, and it is the
 * reason the rate-limit test agreed for this harness is NOT here — it needs eleven requests of its
 * own and there is no way to give it a fresh budget. See the report accompanying this commit.
 *
 * `retries` is 0 in the config for the same reason: a retry would re-spend a budget that has not
 * refilled, turning a genuine failure into a 429 and reporting the wrong cause.
 */

let user: SeededUser;

test.beforeAll(async ({ request }) => {
  // One user for the whole file — created through the REAL POST /auth/register, never inserted.
  // A row inserted directly would carry a hash this harness computed, so a login assertion on it
  // would prove our two helpers agree with each other rather than that registration and login do.
  user = await registerUser(request);
});

test("the real browser reaches the real Next.js app", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  // Asserts served content, not just a status: a 200 from a stale or wrong process would pass a
  // status-only check.
  await expect(page.locator("body")).toContainText("Hospitality Operating System");
});

test("the design tokens are actually applied in the browser, not merely defined", async ({
  page,
}) => {
  // The token layer is unit-tested against `tokens.css` as text. This is the other half: that the
  // stylesheet reaches a real browser and resolves. A build that dropped the `@import` would pass
  // every unit test and fail here.
  await page.goto("/");
  const ground = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--ground").trim(),
  );
  expect(ground).not.toBe("");
  const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bodyBackground).not.toBe("rgba(0, 0, 0, 0)"); // a transparent body borrows the host ground
});

test("the real backend is up, with a real Postgres and a real Redis behind it", async ({
  request,
}) => {
  // /health is outside AuthController, so it costs nothing from the auth budget. It reports the
  // two dependencies separately, which is what makes it useful here — "the harness is green"
  // must not be satisfiable while Redis is down.
  const response = await request.get(`${API_BASE}/health`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    status: string;
    checks: { database: string; redis: string };
  };
  expect(body.checks.database).toBe("ok");
  expect(body.checks.redis).toBe("ok");
  expect(body.status).toBe("ok");
});

test("registration reached real Postgres, and the password was really hashed", async ({}) => {
  // Reads the row the real endpoint wrote. Three assertions, and the second is the one that
  // matters: an endpoint that stored the password verbatim would still accept the right password
  // and reject the wrong one, so the HTTP pair below cannot detect it. Only the storage can.
  const row = await queryOne<{ email: string; password_hash: string }>(
    'SELECT email, password_hash FROM "user" WHERE email = $1',
    [user.email],
  );

  expect(row, "the registered user is not in the e2e database").toBeDefined();
  expect(row?.password_hash).not.toBe(user.password);
  // bcrypt's own format. Asserting the prefix rather than merely "different from the plaintext"
  // rules out a reversible transformation that would also look different.
  expect(row?.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
});

test("the same user is accepted with the right password and rejected with the wrong one", async ({
  request,
}) => {
  // The discriminating pair, at API level, before a screen exists. Either half alone proves
  // nothing: "wrong password is rejected" passes against an implementation that rejects
  // everything, and "right password is accepted" passes against one that accepts everything.
  // The login screen's own test will repeat this shape through the browser.
  const accepted = await login(request, user.email, user.password);
  expect(accepted.status(), await accepted.text()).toBe(200);

  const rejected = await login(request, user.email, `${user.password}-wrong`);
  expect(rejected.status()).toBe(401);
});
