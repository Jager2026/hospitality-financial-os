import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_PLATFORM_TERMS_VERSION,
  PLATFORM_TERMS_PLACEHOLDER,
} from "../common/agreements/agreement-versions";
import { createUserAccount, type UserCreator } from "./create-user-account";

/**
 * The gate, bound to the ACT of creating a `User` rather than to a list of routes (ADR-080).
 *
 * ── What this file has to prove that a per-route test could not ───────────────────────────────
 *
 * Option A would have called the gate on the two routes that create accounts today. The reason C
 * was chosen is that a **third** path cannot miss a check it does not have to remember — so the
 * discriminating test is a caller that is neither route. That is the first case below: it calls
 * `createUserAccount` directly, the way a migration tool or an admin import would, and an
 * implementation that gated only `POST /auth/register` and `POST /memberships/invitations/accept`
 * lets it straight through.
 *
 * The other half of the enforcement is `repo-invariants.spec.ts`, which fails the build if a second
 * way to create a `User` appears anywhere in backend source — including the nested
 * `user: { create }` form, which a Prisma interceptor provably cannot see (measured; the reasoning
 * is in `create-user-account.ts`). Between them: a new path either calls this function and is
 * gated, or it does not compile past the suite.
 *
 * ── Why `vi.stubEnv` and not a parameter ──────────────────────────────────────────────────────
 *
 * `createUserAccount` reads `NODE_ENV` itself, deliberately — a gate a caller has to supply is a
 * gate the third caller forgets. So the tests move the environment instead, which is also the only
 * honest way to exercise a rule whose whole condition is the environment.
 */

/** A creator that records rather than writes: this file is about whether the gate fires, and a
 * real database row would only prove that Prisma works. */
function recordingCreator(): { creator: UserCreator; created: unknown[] } {
  const created: unknown[] = [];
  const creator = {
    user: {
      create: vi.fn().mockImplementation(({ data }: { data: unknown }) => {
        created.push(data);
        return Promise.resolve({ id: randomUUID(), ...(data as object) });
      }),
    },
  } as unknown as UserCreator;
  return { creator, created };
}

const account = () => ({
  email: `gate-${randomUUID()}@example.com`,
  displayName: "Gate Subject",
  passwordHash: "not-a-real-hash",
  locale: "en",
});

describe("createUserAccount — the pre-pilot gate at the point of creation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a caller that is NEITHER route — the case option A would have let through", () => {
    // The terms are still the placeholder, which the suite asserts elsewhere; this is the
    // production half of the same condition.
    expect(CURRENT_PLATFORM_TERMS_VERSION).toBe(PLATFORM_TERMS_PLACEHOLDER);
    vi.stubEnv("NODE_ENV", "production");
    const { creator, created } = recordingCreator();

    return expect(createUserAccount(creator, account()))
      .rejects.toMatchObject({ code: "REGISTRATION_UNAVAILABLE" })
      .then(() => {
        // Asserted on the effect, not only the thrown code: refusing while creating the row anyway
        // would be the same defect in a quieter form.
        expect(created, "no account may be created while the terms are unpublished").toEqual([]);
      });
  });

  it("creates the account outside production — otherwise the refusal above proves nothing", async () => {
    // The discriminating half. A gate that refused everybody would satisfy the case above and be
    // indistinguishable from a broken function — the lesson #108 recorded when its own first
    // falsification flipped a marker for a 500 rather than a denial.
    vi.stubEnv("NODE_ENV", "test");
    const { creator, created } = recordingCreator();

    const user = await createUserAccount(creator, account());

    expect(user.id).toBeTruthy();
    expect(created).toHaveLength(1);
  });

  it("passes the account through unchanged — the gate decides whether, never what", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { creator, created } = recordingCreator();
    const data = account();

    await createUserAccount(creator, data);

    expect(created[0]).toEqual(data);
  });
});
