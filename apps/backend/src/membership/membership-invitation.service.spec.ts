import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { MembershipInvitationService } from "./membership-invitation.service";

// Real database — same precedent as restaurant.service.spec.ts. No external dependency to fake
// here (no Stripe-equivalent), so no Test.createTestingModule() is needed; the service is
// constructed directly.
describe("MembershipInvitationService (real database)", () => {
  const prisma = new PrismaService();
  const service = new MembershipInvitationService(prisma);
  let roleId: string;
  let organizationId: string;
  let inviterUserId: string;

  // No test in this codebase makes a live network call (same precedent as FakeStripeService) —
  // accept() now calls isPasswordBreached() (ADR-032) for every new-user path, so every test here
  // needs fetch stubbed by default, not just the one test that specifically exercises a breach.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeAll(async () => {
    await prisma.$connect();

    // Role/Permission rows are seeded once, globally, before any spec file runs — see
    // test/global-setup.ts. Looked up here, never written.
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    roleId = role.id;

    const organization = await prisma.organization.create({ data: { name: "Invite Test Org" } });
    organizationId = organization.id;

    const inviter = await prisma.user.create({
      data: {
        email: `inviter-${randomUUID()}@example.com`,
        displayName: "Test Inviter",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    inviterUserId = inviter.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("invite() creates a pending invitation and returns the raw token exactly once", async () => {
    const email = `invitee-${randomUUID()}@example.com`;
    const result = await service.invite({ email, roleId }, organizationId, inviterUserId);

    expect(result.email).toBe(email);
    expect(result.token).toBeTruthy();

    const stored = await prisma.membershipInvitation.findUnique({ where: { id: result.id } });
    expect(stored?.tokenHash).not.toBe(result.token); // hashed, not the raw value
    expect(stored?.acceptedAt).toBeNull();
  });

  it("accept() with the correct token creates User + Membership atomically for a brand-new email", async () => {
    const email = `new-person-${randomUUID()}@example.com`;
    const { token } = await service.invite({ email, roleId }, organizationId, inviterUserId);

    const membership = await service.accept({
      email,
      token,
      password: "SetMyOwnPassword!2026",
      displayName: "New Waiter",
    });

    expect(membership.organizationId).toBe(organizationId);
    expect(membership.restaurantId).toBeNull(); // org-wide, no restaurantId given at invite

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.passwordHash).not.toBe("SetMyOwnPassword!2026"); // hashed, not the raw password

    const invitation = await prisma.membershipInvitation.findFirst({ where: { email } });
    expect(invitation?.acceptedAt).not.toBeNull();
  });

  it("accept() rejects an incorrect token without creating any User or Membership", async () => {
    const email = `wrong-token-${randomUUID()}@example.com`;
    await service.invite({ email, roleId }, organizationId, inviterUserId);

    await expect(
      service.accept({ email, token: "not-the-real-token", password: "Whatever!2026xyz" }),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("accept() for an email that already has a User attaches a Membership WITHOUT creating a duplicate User row", async () => {
    const email = `existing-${randomUUID()}@example.com`;
    const existingUser = await prisma.user.create({
      data: {
        email,
        displayName: "Existing User",
        passwordHash: "already-has-a-real-hash",
        locale: "en",
      },
    });

    const { token } = await service.invite({ email, roleId }, organizationId, inviterUserId);
    const membership = await service.accept({ email, token }); // no password — not needed

    expect(membership.userId).toBe(existingUser.id);

    // The discriminating assertion: a naive implementation that always creates a User on accept
    // would leave two rows with this email (impossible anyway, given the unique constraint, but
    // would throw instead of correctly attaching) — this proves the existing row was reused, not
    // that a duplicate merely failed to insert.
    const usersWithEmail = await prisma.user.findMany({ where: { email } });
    expect(usersWithEmail).toHaveLength(1);
  });

  it("accept() cannot be replayed a second time with the same token", async () => {
    const email = `replay-${randomUUID()}@example.com`;
    const { token } = await service.invite({ email, roleId }, organizationId, inviterUserId);

    await service.accept({
      email,
      token,
      password: "FirstAccept!2026xyz",
      displayName: "Replay Test User",
    });

    await expect(
      service.accept({ email, token, password: "SecondAccept!2026xyz" }),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });

    // Exactly one Membership, not two.
    const user = await prisma.user.findUnique({ where: { email } });
    const memberships = await prisma.membership.findMany({ where: { userId: user?.id } });
    expect(memberships).toHaveLength(1);
  });

  it("a restaurant-scoped invitation produces a Membership with that exact restaurantId, not org-wide", async () => {
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId,
        name: "Scoped Test Restaurant",
        legalName: "Scoped Test Restaurant UAB",
        companyNumber: `SCOPE-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `restaurant-${randomUUID()}@example.com`,
        phone: "+37060000002",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Scoped 1, Vilnius",
      },
    });

    const email = `scoped-${randomUUID()}@example.com`;
    const { token } = await service.invite(
      { email, roleId, restaurantId: restaurant.id },
      organizationId,
      inviterUserId,
    );
    const membership = await service.accept({
      email,
      token,
      password: "ScopedAccept!2026xyz",
      displayName: "Scoped Test User",
    });

    expect(membership.restaurantId).toBe(restaurant.id);
  });

  it("rejects accepting an invitation with a known-breached password, without creating a user", async () => {
    const email = `breached-${randomUUID()}@example.com`;
    const { token } = await service.invite({ email, roleId }, organizationId, inviterUserId);
    // Overrides the beforeEach's default "not breached" stub. Same real HIBP fixture as
    // hibp.util.spec.ts/auth.service.spec.ts: "password" -> prefix 5BAA6, suffix
    // 1E4C9B93F3F0682250B6CF8331B7EE68FD8.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("1E4C9B93F3F0682250B6CF8331B7EE68FD8:3730471"),
      }),
    );

    await expect(
      service.accept({ email, token, password: "password", displayName: "Breached User" }),
    ).rejects.toMatchObject({ code: "PASSWORD_BREACHED" });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeNull();
  });
});
