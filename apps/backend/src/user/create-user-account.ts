import type { Prisma, User } from "@prisma/client";
import {
  assertPlatformTermsPublished,
  CURRENT_PLATFORM_TERMS_VERSION,
} from "../common/agreements/agreement-versions";

/**
 * The one sanctioned way to create a `User`, and the place the pre-pilot gate now lives (ADR-080).
 *
 * ── Why the check moved here ──────────────────────────────────────────────────────────────────
 *
 * `assertPlatformTermsPublished` used to be called by `AuthController.register` and nowhere else,
 * so `POST /memberships/invitations/accept` minted accounts the gate knew nothing about. ADR-055
 * had already made this exact correction once, one level out: it moved the gate off the
 * registration SCREEN and onto the route, having found that *a gate that protects a screen protects
 * nothing*. A gate on one route protects nothing if a second route reaches the same outcome.
 *
 * Binding it to the **act** rather than to a list of routes is the Founder's decision (option C):
 * a remedy chosen by the property of the defect, not by the instances of it. A third path — a
 * migration tool, an admin import, whatever arrives next — cannot miss a check it does not have to
 * remember.
 *
 * ── What "every creation" honestly means, because it is narrower than it sounds ────────────────
 *
 * **There is no point in Postgres or in Prisma through which every `User` creation passes. That
 * was measured, not assumed**, and it is the fact that decided this file's shape:
 *
 *   - A `$extends` query interceptor on `user.create` DOES fire for `tx.user.create` inside an
 *     interactive transaction — 2 of 2, and both of today's call sites are exactly that. So the
 *     transaction was never the obstacle.
 *   - **A nested write escapes it entirely.** `membership.create({ data: { user: { create } } })`
 *     creates a `User` and the `user.create` interceptor sees **zero**. Measured against the real
 *     database.
 *
 * So a runtime interceptor would have been a gate with a documented way around it — the shape
 * `CLAUDE.md` calls a record that looks like a mechanism. What is enforceable instead is that this
 * repository contains exactly one way to create a `User`, and `repo-invariants.spec.ts` fails the
 * build if a second appears, in either form. That is a claim about this codebase rather than about
 * the database, and it is stated that way rather than dressed up: a `psql` session or a raw
 * `$executeRaw` is outside it.
 *
 * ── Consequences worth knowing at the call sites ──────────────────────────────────────────────
 *
 * **An existing account accepting an invitation is not gated, and should not be.** Nothing is
 * created and no acceptance is recorded, so there is no false record to prevent — which falls out
 * of binding the check to creation rather than to the route, where it would have had to be
 * special-cased.
 *
 * **Registration now refuses later than it used to** — after the password is hashed and the breach
 * check has run, rather than before. Same status, same code, a little wasted work on a request that
 * is refused anyway. Named here because it is a real change and the alternative was leaving a
 * second copy of the rule in the controller for two mechanisms to keep in step.
 */
export interface NewUserAccount {
  email: string;
  displayName: string;
  passwordHash: string;
  locale: string;
}

/**
 * Anything that can create a `User` — the real client or a transaction client. Typed structurally
 * so a caller inside `$transaction` passes `tx` without a cast.
 */
export type UserCreator = Pick<Prisma.TransactionClient, "user">;

export async function createUserAccount(tx: UserCreator, data: NewUserAccount): Promise<User> {
  // Read here rather than taken as a parameter, deliberately: a gate a caller has to remember to
  // supply is a gate a third caller forgets. `validateEnv` makes NODE_ENV a required enum with no
  // default (ADR-045), so it cannot be absent without the app refusing to boot — the same fact
  // `StripeService`'s boot probe already depends on.
  assertPlatformTermsPublished(process.env.NODE_ENV ?? "", CURRENT_PLATFORM_TERMS_VERSION);

  return await tx.user.create({ data });
}
