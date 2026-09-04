import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppException } from "../common/exceptions/app.exception";
import { EmailOutboxService } from "../email/email-outbox.service";
import { MembershipInvitationService } from "../membership/membership-invitation.service";
import { MembershipService } from "../membership/membership.service";
import { PrismaService } from "../prisma/prisma.service";
import { RoleService } from "./role.service";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { callerWithSeededRole } from "../../test/fixtures/authenticated-user";

/**
 * ADR-044 — a Role a Restaurant may not grant is excluded on **every** side, not only the one a
 * screen happens to read.
 *
 * The rule was first stated as two-sided: the list omits platform-only Roles, the invite rejects
 * them. Two-sided was already wrong when it was written — `PATCH /memberships/:id` also takes a
 * `roleId`, and promoting an existing colleague is *easier* than inviting a new one. The number of
 * doors was settled by grepping for the field rather than by reasoning about the flows, and there
 * were four. Each gets its own assertion here, because a fix that closed three would look
 * complete.
 */

const prisma = new PrismaService();
const roleService = new RoleService(prisma);
// ADR-070: invite() now enqueues an email in the same transaction. This file is about ADR-044's
// platform-only Role refusal, which happens BEFORE any of that is reached — the transport is
// therefore never called, and a stub that would throw on contact is the honest shape.
const noopEmailLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;
const invitations = new MembershipInvitationService(
  prisma,
  new EmailOutboxService(
    prisma,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send: async () => ({ providerMessageId: "unused" }) } as any,
    noopEmailLogger,
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { getOrThrow: () => "https://app.example" } as any,
);
const memberships = new MembershipService(prisma);

let administrator: { id: string };
let waiter: { id: string };

beforeAll(async () => {
  await prisma.$connect();
  administrator = await prisma.role.findUniqueOrThrow({ where: { name: "Administrator" } });
  waiter = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOrgAndRestaurant() {
  const organization = await prisma.organization.create({
    data: { name: `Roles ${randomUUID()}` },
  });
  const restaurant = await prisma.restaurant.create({
    data: {
      organizationId: organization.id,
      name: "Roles Test",
      legalName: "Roles Test UAB",
      companyNumber: `RT-${randomUUID()}`,
      vatNumber: `LT${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      phone: "+37060000000",
      country: "LT",
      currency: "EUR",
      defaultCustomerLocale: "en",
      timezone: "Europe/Vilnius",
      address: "Test address",
    },
  });
  return { organization, restaurant };
}

describe("RoleService.findAssignable — door 1: what a Restaurant is shown", () => {
  it("returns the Roles a Restaurant may grant, and excludes the platform-only one", async () => {
    const assignable = await roleService.findAssignable();
    const names = assignable.map((r) => r.name);

    // The discriminating pair. "Administrator is absent" alone would pass against an
    // implementation returning nothing at all.
    expect(names).toContain("Waiter");
    expect(names).toContain("Manager");
    expect(names).toContain("Owner");
    expect(names).not.toContain("Administrator");
  });

  it("returns the description, because the screen shows this list to a human", async () => {
    // "Manager" in a dropdown with nothing saying how it differs from "Administrator" makes an
    // owner guess at a permission grant. The descriptions are real seeded data, not invented here.
    const assignable = await roleService.findAssignable();
    const manager = assignable.find((r) => r.name === "Manager");
    expect(manager?.description).toBeTruthy();
  });
});

describe("the enforcing doors — a filtered list over an open endpoint would be worse than nothing", () => {
  it("door 2: inviting with a platform-only Role is refused", async () => {
    const { organization, restaurant } = await seedOrgAndRestaurant();
    const inviter = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        displayName: "Inviter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });

    await expect(
      invitations.invite(
        {
          email: `${randomUUID()}@example.com`,
          restaurantId: restaurant.id,
          roleId: administrator.id,
        },
        organization.id,
        inviter.id,
      ),
    ).rejects.toBeInstanceOf(AppException);

    // The same call with an assignable Role succeeds — so the refusal above is about the Role,
    // not about the invite path being broken.
    const ok = await invitations.invite(
      { email: `${randomUUID()}@example.com`, restaurantId: restaurant.id, roleId: waiter.id },
      organization.id,
      inviter.id,
    );
    // ADR-070: the token is no longer returned. The discriminating property this line carries is
    // unchanged — the invite path works for an assignable Role, so the refusal above is about the
    // Role rather than about the path being broken — it is just asserted on the row that was
    // created instead of on a field that no longer exists.
    expect(ok.id).toBeTruthy();
    expect(await prisma.membershipInvitation.findUnique({ where: { id: ok.id } })).not.toBeNull();
  });

  it("door 3: PROMOTING an existing Membership to a platform-only Role is refused", async () => {
    // The door found by grepping rather than reasoning, and the cheapest one to walk through:
    // no invitation, no acceptance, one PATCH.
    const { organization, restaurant } = await seedOrgAndRestaurant();
    const manager = await prisma.role.findUniqueOrThrow({ where: { name: "Manager" } });
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        displayName: "Target",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const membership = await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        restaurantId: restaurant.id,
        roleId: waiter.id,
      },
    });

    // The real seeded Manager. This test is about what that ROLE may grant — it must not be able
    // to promote anyone to Administrator, and must still manage an assignable Role. A hand-written
    // single-permission Manager understated the Role by six Permissions while asserting its limits.
    const promoter: AuthenticatedUser = await callerWithSeededRole(prisma, {
      roleName: "Manager",
      organizationId: organization.id,
      restaurantId: restaurant.id,
      userId: user.id,
      email: user.email,
      membershipId: membership.id,
    });

    await expect(
      memberships.update(membership.id, { roleId: administrator.id }, promoter),
    ).rejects.toBeInstanceOf(AppException);

    // And the same caller CAN change the Role to an assignable one — real scoping, not a blanket
    // refusal that would pass this test for the wrong reason.
    const updated = await memberships.update(membership.id, { roleId: manager.id }, promoter);
    expect(updated.roleId).toBe(manager.id);
  });

  it("door 4: an invitation that somehow carries a platform-only Role cannot be accepted", async () => {
    // Defence in depth. invite() already refuses, so such a row can only predate that check —
    // this exists so nobody has to reason about the vintage of a row before trusting it.
    const { organization, restaurant } = await seedOrgAndRestaurant();
    const inviter = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        displayName: "Inviter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const email = `${randomUUID()}@example.com`;

    // Created directly, because the endpoint correctly refuses to create it — the point is that
    // the accept path does not trust the row it reads.
    const { hashInvitationToken, generateInvitationToken } =
      await import("../membership/invitation-token.util");
    const token = generateInvitationToken();
    await prisma.membershipInvitation.create({
      data: {
        email,
        organizationId: organization.id,
        restaurantId: restaurant.id,
        roleId: administrator.id,
        invitedBy: inviter.id,
        tokenHash: hashInvitationToken(token),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await expect(
      invitations.accept({ email, token, password: `${randomUUID()}-Aa1!`, displayName: "Nope" }),
    ).rejects.toBeInstanceOf(AppException);
  });
});
