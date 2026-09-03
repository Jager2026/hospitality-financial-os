import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedUser } from "../../src/auth/guards/jwt-auth.guard";

/**
 * Two ways to build an `AuthenticatedUser`, and the whole point is that they are two.
 *
 * The drift this exists to stop was never "a literal in a spec". It was a fixture **naming a
 * seeded Role and describing permissions the seed does not give it** — an `"Owner"` holding two of
 * its ten Permissions, and later one holding none at all. Those fixtures proved things about a
 * system that does not exist, and the name is what made them look trustworthy.
 *
 * A narrow synthetic caller is legitimate and often necessary: many tests exist precisely to show
 * that holding ONE permission is not enough, and giving them the real seven-permission Manager
 * would destroy the discrimination they were written for. What is never legitimate is a synthetic
 * caller wearing a real Role's name.
 *
 * So: `callerWithSeededRole` reads the Role and its Permissions from the database — which
 * `global-setup.ts` seeds from `prisma/seed.ts`, so the fixture cannot disagree with production
 * data. `syntheticCaller` builds an arbitrary permission set and **refuses a seeded Role name at
 * runtime**, which puts the rule where someone will meet it rather than only in a review comment.
 */

export const SEEDED_ROLE_NAMES = [
  "Owner",
  "Administrator",
  "Manager",
  "Accountant",
  "Waiter",
] as const;
export type SeededRoleName = (typeof SEEDED_ROLE_NAMES)[number];

/** The Role exactly as seeded — id, name, and the Permission names actually granted to it. */
export async function seededRole(
  prisma: PrismaClient,
  name: SeededRoleName,
): Promise<{ id: string; name: string; permissions: string[] }> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name },
    include: { rolePermissions: { include: { permission: true } } },
  });
  return {
    id: role.id,
    name: role.name,
    permissions: role.rolePermissions.map((rp) => rp.permission.name),
  };
}

interface SeededCallerOptions {
  roleName: SeededRoleName;
  organizationId: string;
  /** `null` means an org-wide Membership (ADR-005). */
  restaurantId: string | null;
  userId?: string;
  email?: string;
  membershipId?: string;
}

/**
 * A caller holding a real seeded Role, with the Permissions the seed actually grants it. Use this
 * whenever the test is about what a *Role* can do — those are the assertions that go quietly wrong
 * when a hand-written list drifts from `seed.ts`.
 */
export async function callerWithSeededRole(
  prisma: PrismaClient,
  options: SeededCallerOptions,
): Promise<AuthenticatedUser> {
  const role = await seededRole(prisma, options.roleName);
  return {
    id: options.userId ?? randomUUID(),
    email: options.email ?? `${randomUUID()}@example.com`,
    locale: "en",
    memberships: [
      {
        id: options.membershipId ?? randomUUID(),
        organizationId: options.organizationId,
        restaurantId: options.restaurantId,
        role,
      },
    ],
  };
}

interface SyntheticCallerOptions {
  /** Deliberately arbitrary — the point is usually that it is NARROWER than any real Role. */
  permissions: string[];
  organizationId: string;
  restaurantId: string | null;
  /** Must not be a seeded Role name; defaults to a label that cannot be mistaken for one. */
  roleLabel?: string;
  roleId?: string;
  userId?: string;
  email?: string;
  membershipId?: string;
}

/**
 * A caller with a deliberately constructed permission set, for tests about the permission CHECK
 * rather than about a Role. Refuses to wear a seeded Role's name.
 */
export function syntheticCaller(options: SyntheticCallerOptions): AuthenticatedUser {
  const label = options.roleLabel ?? "SyntheticRole";
  if ((SEEDED_ROLE_NAMES as readonly string[]).includes(label)) {
    throw new Error(
      `syntheticCaller() was given the seeded Role name "${label}". A synthetic permission set ` +
        `must not carry a real Role's name — that is exactly how a fixture describing an "Owner" ` +
        `with two of its ten Permissions stayed believable. Use callerWithSeededRole() for a real ` +
        `Role, or pick a label that is obviously not one.`,
    );
  }
  return {
    id: options.userId ?? randomUUID(),
    email: options.email ?? `${randomUUID()}@example.com`,
    locale: "en",
    memberships: [
      {
        id: options.membershipId ?? randomUUID(),
        organizationId: options.organizationId,
        restaurantId: options.restaurantId,
        role: { id: options.roleId ?? randomUUID(), name: label, permissions: options.permissions },
      },
    ],
  };
}
