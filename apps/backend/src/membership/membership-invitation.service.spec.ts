import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOutboxService } from "../email/email-outbox.service";
import { PrismaService } from "../prisma/prisma.service";
import { readInvitationEmail } from "../../test/fixtures/invitation-email";
import { MembershipInvitationService } from "./membership-invitation.service";

// Real database — same precedent as restaurant.service.spec.ts. The service is constructed
// directly rather than through Test.createTestingModule().
//
// ADR-070: invite() now enqueues an email in the same transaction, so the real EmailOutboxService
// is wired in with a transport that is never reached — the poller is not running in this file, so
// nothing dispatches. What the tests read is the QUEUED message, which is how the recipient gets
// the token now that the API response no longer carries it.
describe("MembershipInvitationService (real database)", () => {
  const prisma = new PrismaService();
  const noopLogger = {
    setContext: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const emailOutbox = new EmailOutboxService(
    prisma,
    // Never called: nothing in this file dispatches the Outbox.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send: async () => ({ providerMessageId: "unused" }) } as any,
    noopLogger,
  );
  const service = new MembershipInvitationService(prisma, emailOutbox, {
    getOrThrow: () => "https://app.example",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  /** Invite, then read the token out of the queued email — the only place it exists now. Every
   * call is therefore also an assertion that the email was enqueued and carries a usable link. */
  async function inviteAndReadToken(...args: Parameters<typeof service.invite>): Promise<string> {
    await service.invite(...args);
    const { token } = await readInvitationEmail(prisma, args[0].email);
    return token;
  }

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

  it(
    "invite() creates a pending invitation and does NOT return the token — it goes to the email " +
      "and nowhere else, because a token in two places means the email path is never exercised",
    async () => {
      const email = `invitee-${randomUUID()}@example.com`;
      const result = await service.invite({ email, roleId }, organizationId, inviterUserId);

      expect(result.email).toBe(email);
      // THE FALSIFICATION the task asked for: an implementation that kept returning the token
      // fails here, and it is asserted over the whole serialised response rather than one field so
      // that renaming the field does not quietly restore the leak.
      expect(JSON.stringify(result)).not.toContain("token");

      const stored = await prisma.membershipInvitation.findUnique({ where: { id: result.id } });
      expect(stored?.acceptedAt).toBeNull();

      // The token exists exactly once, in the queued message, and it is the hash of THAT token the
      // invitation stores — proven by using it to accept below in the other tests.
      const { token, acceptUrl, subject } = await readInvitationEmail(prisma, email);
      expect(token).toBeTruthy();
      expect(stored?.tokenHash).not.toBe(token); // hashed, not the raw value
      expect(acceptUrl).toContain("https://app.example/invitations/accept");
      expect(subject).toContain("invited you to join");
    },
  );

  it("accept() with the correct token creates User + Membership atomically for a brand-new email", async () => {
    const email = `new-person-${randomUUID()}@example.com`;
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

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

    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);
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
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

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
    const token = await inviteAndReadToken(
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
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);
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
