import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect } from "@playwright/test";
import { BACKEND_PORT } from "../playwright.config";

export const API_BASE = `http://localhost:${BACKEND_PORT}`;

export interface SeededUser {
  email: string;
  password: string;
  displayName: string;
}

/**
 * Creates a user through the **real** `POST /auth/register`, never by inserting a row.
 *
 * That distinction is the whole point of the fixture. A row inserted directly would carry a hash
 * this test computed, against a cost factor this test chose, skipping every validation the real
 * endpoint performs — so a login test built on it would prove that our own two functions agree
 * with each other, not that registration and login agree. Going through the endpoint means the
 * fixture exercises the same path a real owner does, including the password hashing the login
 * test then depends on.
 *
 * Every user gets a unique email. Tests never share an account, so one test's rate-limit
 * consumption or session state cannot reach another's — which matters more here than usual, see
 * the throttle note in `tests/harness.spec.ts`.
 */
export async function registerUser(
  request: APIRequestContext,
  overrides: Partial<SeededUser> = {},
): Promise<SeededUser> {
  const user: SeededUser = {
    email: overrides.email ?? `e2e-${randomUUID()}@example.test`,
    // Deliberately not a common password: `POST /auth/register` runs the breached-corpus check
    // (ADR-032), and a memorable placeholder like "Password123!" is in that corpus. A fixture
    // that failed for that reason would look like a broken harness.
    password: overrides.password ?? `e2e-${randomUUID()}-Aa1!`,
    displayName: overrides.displayName ?? "E2E Harness User",
  };

  const response = await request.post(`${API_BASE}/api/v1/auth/register`, {
    // `displayName`, camelCase — the field the real `registerSchema` requires. `API_Contract.md`
    // documents `display_name`, and is wrong: every DTO in this codebase is camelCase
    // (`restaurantId`, `roleId`, `waiterMembershipId`), while the contract document is snake_case
    // throughout. Caught by the first real HTTP request this harness ever made, which is the
    // argument for building it before the screen rather than alongside one.
    data: {
      email: user.email,
      password: user.password,
      displayName: user.displayName,
    },
  });

  expect(
    response.ok(),
    `register failed (${response.status()}): ${await response.text()}`,
  ).toBeTruthy();

  return user;
}

/** Logs in through the real endpoint and returns the raw response, so a caller can assert on a
 * rejection as easily as on a success. */
export async function login(
  request: APIRequestContext,
  email: string,
  password: string,
): ReturnType<APIRequestContext["post"]> {
  return request.post(`${API_BASE}/api/v1/auth/login`, { data: { email, password } });
}
