import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../auth/auth.service";
import type { TokenService } from "../auth/token.service";
import { AppException } from "../common/exceptions/app.exception";
import { hashPassword } from "../auth/password.util";
import {
  AlreadyRedactedError,
  REDACTED_DISPLAY_NAME,
  UserNotFoundError,
  executeRedaction,
  planRedaction,
} from "./redact-user";

/**
 * The erasure mechanism, against the real database (ADR-052).
 *
 * Every claim below is a pair. The half that asserts something is *gone* would pass against a
 * mechanism that emptied the entire database, and the half that asserts something *survived* would
 * pass against a mechanism that did nothing at all. Only together do they say that the person was
 * emptied and the financial record was not.
 */
describe("User redaction (real database)", () => {
  const prisma = new PrismaService();
  const password = "correct horse battery staple";
  let email: string;
  let userId: string;
  let membershipId: string;
  let ledgerTotalBefore: bigint;

  beforeAll(async () => {
    await prisma.$connect();

    email = `redact-${randomUUID()}@example.com`;
    const user = await prisma.user.create({
      data: {
        email,
        displayName: "Person To Erase",
        passwordHash: await hashPassword(password),
        locale: "en",
      },
    });
    userId = user.id;

    const organization = await prisma.organization.create({ data: { name: "Redaction Test Org" } });
    const currency = await prisma.currency.findUniqueOrThrow({ where: { code: "EUR" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: organization.id,
        name: "Redaction Test",
        legalName: "Redaction Test UAB",
        companyNumber: `RED-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `${randomUUID()}@example.com`,
        phone: "+37060000000",
        country: "LT",
        currency: currency.code,
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
      },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const membership = await prisma.membership.create({
      data: {
        userId,
        organizationId: organization.id,
        restaurantId: restaurant.id,
        roleId: role.id,
        status: "ACTIVE",
      },
    });
    membershipId = membership.id;

    // An invitation carrying the same address, because the email lives there independently of
    // `User` and a redaction that missed it would leave the address fully findable.
    await prisma.membershipInvitation.create({
      data: {
        email,
        organizationId: organization.id,
        restaurantId: restaurant.id,
        roleId: role.id,
        invitedBy: userId,
        tokenHash: "not-a-real-token-hash",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const lines = await prisma.ledgerLine.aggregate({
      _sum: { amount: true },
      where: { membershipId },
    });
    ledgerTotalBefore = lines._sum.amount ?? 0n;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("POSITIVE CONTROL: before redaction the person is findable by email and can log in", async () => {
    // Without this, every assertion below passes against a user who was already empty — which is
    // exactly the state a broken mechanism would leave behind, and exactly the state a mechanism
    // that never ran would find.
    const found = await prisma.user.findUnique({ where: { email } });
    expect(found?.id).toBe(userId);

    const auth = new AuthService(prisma, {
      issueTokenPair: async () => ({ accessToken: "a", refreshToken: "r" }),
    } as unknown as TokenService);
    const result = await auth.login({ email, password });
    expect(result.user.id).toBe(userId);
  });

  it("refuses an address that does not exist, rather than silently doing nothing", async () => {
    await expect(
      planRedaction(prisma, `absent-${randomUUID()}@example.com`),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("empties the person: no row anywhere still carries the original address", async () => {
    const plan = await planRedaction(prisma, email);
    expect(plan.invitationRows).toBe(1);
    expect(plan.membershipsRetained).toBe(1);

    await executeRedaction(prisma, plan);

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(await prisma.membershipInvitation.count({ where: { email } })).toBe(0);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.email).not.toBe(email);
    expect(after.email).toMatch(/@invalid$/);
    expect(after.displayName).toBe(REDACTED_DISPLAY_NAME);
    expect(after.lastLogin).toBeNull();
    expect(after.status).toBe("INACTIVE");
    expect(after.deletedAt).not.toBeNull();
  });

  it("keeps the financial subject: the Membership and its Ledger total are untouched", async () => {
    // The half that makes the emptying above meaningful. A mechanism that deleted the person
    // outright, or that cascaded into Membership, would pass every assertion in the previous test
    // and fail here — and it would take the ten-year accounting record with it.
    const membership = await prisma.membership.findUnique({ where: { id: membershipId } });
    expect(membership).not.toBeNull();
    expect(membership?.userId).toBe(userId);
    expect(membership?.status).toBe("ACTIVE");

    const lines = await prisma.ledgerLine.aggregate({
      _sum: { amount: true },
      where: { membershipId },
    });
    expect(lines._sum.amount ?? 0n).toBe(ledgerTotalBefore);
  });

  it("locks the account out for a reason other than the address having changed", async () => {
    const auth = new AuthService(prisma, {
      issueTokenPair: async () => ({ accessToken: "a", refreshToken: "r" }),
    } as unknown as TokenService);

    // The original address no longer resolves. On its own this proves less than it looks: the
    // email was replaced, so this would pass even if `deletedAt` were never set and the account
    // were otherwise fully usable under its new address.
    await expect(auth.login({ email, password })).rejects.toBeInstanceOf(AppException);

    // So the address is removed as an explanation. A known password is written directly onto the
    // redacted row, bypassing the mechanism, and the login is attempted against the tombstone
    // address, which genuinely exists. The address resolves and the password is correct, so what
    // remains is the row being marked unusable.
    //
    // Stated as "marked unusable" rather than "deletedAt", because falsification proved the
    // narrower claim false: removing `deletedAt` from the mechanism left this test passing.
    // `AuthService.login` refuses on `deletedAt` AND on `status !== "ACTIVE"`, independently, and
    // the redaction sets both — so either one alone still rejects. `deletedAt` specifically is
    // covered by the double-redaction test below, which is what actually failed when it was
    // removed. The comment is narrowed to what this case demonstrates rather than left claiming
    // an isolation it does not achieve.
    const redacted = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password) },
    });

    await expect(auth.login({ email: redacted.email, password })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it("refuses to redact the same person twice", async () => {
    // A second run would replace one tombstone with another and destroy the record of when the
    // first erasure happened — the one fact a regulator is most likely to ask for.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await expect(planRedaction(prisma, after.email)).rejects.toBeInstanceOf(AlreadyRedactedError);
  });
});
