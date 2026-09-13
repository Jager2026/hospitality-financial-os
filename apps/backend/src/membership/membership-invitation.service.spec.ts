import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOutboxService } from "../email/email-outbox.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  CURRENT_PLATFORM_TERMS_VERSION,
  PLATFORM_TERMS_PLACEHOLDER,
} from "../common/agreements/agreement-versions";
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
    // NODE_ENV is stubbed by the ADR-080 gate tests below; leaking it into the next case would
    // silently change what every other test in this file is exercising.
    vi.unstubAllEnvs();
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

  // The concurrency test below seeds a User and, on a broken implementation, more than one
  // Membership for it. Scoped to this fixture's own email prefix rather than to one run's ids, so a
  // run killed before reaching here leaves rows the next run clears — and so a run that FAILS,
  // which is the interesting one, does not leave duplicate ACTIVE memberships behind. That matters
  // more than tidiness here: those rows are exactly what the new unique index refuses, so leaving
  // them would make the next migration fail on this developer's machine.
  //
  // The Users themselves are left alone: other tables reference them, and deleting a User is
  // redact-user.ts's job, not a spec's.
  afterAll(async () => {
    const mine = await prisma.user.findMany({
      where: { email: { startsWith: "race-" } },
      select: { id: true },
    });
    await prisma.membership.deleteMany({ where: { userId: { in: mine.map((u) => u.id) } } });

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
      acceptedTermsVersion: CURRENT_PLATFORM_TERMS_VERSION,
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
      acceptedTermsVersion: CURRENT_PLATFORM_TERMS_VERSION,
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
      acceptedTermsVersion: CURRENT_PLATFORM_TERMS_VERSION,
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
      service.accept({
        email,
        token,
        password: "password",
        displayName: "Breached User",
        acceptedTermsVersion: CURRENT_PLATFORM_TERMS_VERSION,
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_BREACHED" });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeNull();
  });

  // ─── The consent this path used to skip (ADR-049) ────────────────────────────────────────────
  //
  // Accepting an invitation is the SECOND way a `User` is created, and it wrote no
  // `AgreementAcceptance` — so everybody who joined through an invitation was using the platform
  // with no record of having agreed to anything. It could not be repaired afterwards: a row
  // written later asserts that a person agreed at a moment when nobody asked them.

  it("accept() records the platform-terms acceptance for a User it creates, with the request's context", async () => {
    const email = `consent-${randomUUID()}@example.com`;
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

    await service.accept(
      {
        email,
        token,
        password: "ConsentGiven!2026xyz",
        displayName: "Consenting Waiter",
        acceptedTermsVersion: CURRENT_PLATFORM_TERMS_VERSION,
      },
      { ipAddress: "203.0.113.7", userAgent: "AcceptSpec/1.0" },
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const acceptances = await prisma.agreementAcceptance.findMany({ where: { userId: user.id } });

    expect(acceptances).toHaveLength(1);
    expect(acceptances[0]).toMatchObject({
      agreement: "PLATFORM_TERMS",
      // From the server's constant, never a literal typed here: a literal cannot be wrong when it
      // is written and cannot stay right afterwards (CLAUDE.md, Testing Philosophy).
      version: CURRENT_PLATFORM_TERMS_VERSION,
      ipAddress: "203.0.113.7",
      userAgent: "AcceptSpec/1.0",
    });
  });

  it("accept() records NO acceptance when the User already exists — they agreed when they registered", async () => {
    // The other half of the pair. A check that only ever wrote rows would pass the test above just
    // as well, and would be wrong here: a second row would claim this person agreed twice, on a day
    // they were not asked.
    const email = `already-consented-${randomUUID()}@example.com`;
    const existing = await prisma.user.create({
      data: {
        email,
        displayName: "Already Has An Account",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

    await service.accept({ email, token });

    expect(await prisma.agreementAcceptance.count({ where: { userId: existing.id } })).toBe(0);
  });

  it("accept() refuses to create a User without the terms, and creates nothing at all", async () => {
    const email = `no-consent-${randomUUID()}@example.com`;
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

    await expect(
      service.accept({ email, token, password: "NoConsent!2026xyz", displayName: "No Consent" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Asserted on the database rather than only on the rejection: refusing while leaving a User
    // behind would be the same defect in a quieter form.
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    const invitation = await prisma.membershipInvitation.findFirst({ where: { email } });
    expect(invitation?.acceptedAt, "the invitation must remain usable").toBeNull();
  });

  it("accept() refuses a terms version that is not the server's own, and creates nothing", async () => {
    const email = `stale-terms-${randomUUID()}@example.com`;
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

    await expect(
      service.accept({
        email,
        token,
        password: "StaleTab!2026xyz",
        displayName: "Stale Tab",
        acceptedTermsVersion: `${CURRENT_PLATFORM_TERMS_VERSION}-but-older`,
      }),
    ).rejects.toMatchObject({ code: "TERMS_VERSION_MISMATCH" });

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  // ─── The gate, reached through this route (ADR-080) ──────────────────────────────────────────
  //
  // The headline falsification of ADR-080's option C. Before that decision this path created an
  // account while the pre-pilot gate — which refuses `POST /auth/register` in production while the
  // platform terms are unpublished — knew nothing about it. These two tests are what would have
  // failed then and what fails again if the check ever drifts back onto the routes.

  it("refuses to create an account in production while the terms are unpublished", async () => {
    expect(CURRENT_PLATFORM_TERMS_VERSION).toBe(PLATFORM_TERMS_PLACEHOLDER);
    vi.stubEnv("NODE_ENV", "production");
    const email = `gated-${randomUUID()}@example.com`;
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

    await expect(
      service.accept({
        email,
        token,
        password: "WouldHaveWorked!2026",
        displayName: "Gated Invitee",
        acceptedTermsVersion: CURRENT_PLATFORM_TERMS_VERSION,
      }),
    ).rejects.toMatchObject({ code: "REGISTRATION_UNAVAILABLE" });

    // Nothing created, and the invitation still usable once the terms exist.
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    const invitation = await prisma.membershipInvitation.findFirst({ where: { email } });
    expect(
      invitation?.acceptedAt,
      "a refused acceptance must not consume the invitation",
    ).toBeNull();
  });

  it("still accepts in production for someone who ALREADY has an account — nothing is created", async () => {
    // The property that falls out of binding the check to creation rather than to the route, and
    // the reason it is better than gating the route: this person is not being given an account and
    // no acceptance is recorded for them, so there is no false record to prevent. Option A would
    // have had to special-case exactly this.
    vi.stubEnv("NODE_ENV", "production");
    const email = `already-${randomUUID()}@example.com`;
    await prisma.user.create({
      data: {
        email,
        displayName: "Already Has One",
        passwordHash: "not-a-real-hash",
        locale: "en",
      },
    });
    const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

    const membership = await service.accept({ email, token });

    expect(membership.organizationId).toBe(organizationId);
  });

  // ── The race, reproduced before it was fixed ────────────────────────────────────────────────
  //
  // `accept()` read the User outside its transaction, hashed a password (bcrypt, deliberately
  // slow), and only then opened the transaction that creates the Membership and stamps the
  // invitation. The invitation lookup filters `acceptedAt: null`, so the READ was guarded; the
  // write was `update({ where: { id } })` with no condition, so nothing serialised two accepts.
  //
  // **Which half is reproduced, and why it has to be this one.** With a brand-new email both
  // callers reach `createUserAccount`, and `User.email @unique` aborts the second transaction —
  // the path is protected by a constraint that happens to exist. When the User already exists
  // both callers skip creation, both create a Membership, and **nothing at all stands in the
  // way**. That asymmetry is the argument for the constraint added here: the code is safe exactly
  // where a constraint is, and nowhere else.
  it(
    "two concurrent accepts of one invitation create exactly ONE Membership and accept the " +
      "invitation once — reproduced against the real database before it was fixed, and failing " +
      "then with two rows",
    async () => {
      const email = `race-${randomUUID()}@example.com`;
      // The User pre-exists, which is an ordinary case: somebody already on the platform invited
      // to a second Organization. It is also the half no constraint covered.
      const user = await prisma.user.create({
        data: {
          email,
          displayName: "Already A User",
          passwordHash: "not-a-real-hash",
          locale: "en",
        },
      });
      const token = await inviteAndReadToken({ email, roleId }, organizationId, inviterUserId);

      const results = await Promise.allSettled([
        service.accept({ email, token }),
        service.accept({ email, token }),
      ]);

      const memberships = await prisma.membership.count({
        where: { userId: user.id, organizationId },
      });
      expect(
        memberships,
        "one invitation produced two Memberships — by ADR-006 that is two Wallets for one person " +
          "at one employer, and their tips split between them",
      ).toBe(1);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(
        fulfilled,
        "both accepts succeeded, so the invitation was accepted twice",
      ).toHaveLength(1);
    },
    30_000,
  );
});
