import { randomUUID } from "node:crypto";
import { readInvitationEmail } from "../../test/fixtures/invitation-email";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../prisma/prisma.service";
import type {
  ConnectAccountStatus,
  CreateConnectAccountParams,
  CreatedPaymentIntent,
  CreatePaymentIntentParams,
} from "../stripe/stripe.service";
import { StripeService } from "../stripe/stripe.service";
import { PLATFORM_TERMS_PLACEHOLDER } from "../common/agreements/agreement-versions";

/**
 * Does `PATCH /memberships/{id}/disable` actually stop the disabled person doing anything?
 *
 * Reading the code says no, and reading is not enough for an access-control claim. `JwtAuthGuard`
 * loads `user.memberships` with **no filter on the Membership's own `status`**; `AuthenticatedUser`
 * does not even carry a `status` field, so `PermissionsGuard` and `restaurant-reachability.util.ts`
 * cannot consult one. The `status !== "ACTIVE"` check that does exist is on the **User**, which is
 * a different row and is untouched by disabling a Membership.
 *
 * That is a claim about what does NOT happen, which is exactly the shape this project has been
 * wrong about before — the cross-Organization leak was found by reading evaluation order after a
 * text search had certified the opposite. So: an execution that would fail if the reading were
 * wrong.
 *
 * Asserted as a pair. The same person is shown succeeding before the disable and failing after it.
 * The success half is not decoration: without it, a denial proves nothing — a system that denies
 * this request for an unrelated reason (wrong permission, unreachable restaurant, expired token)
 * would produce an identical red-to-green story.
 */

const PASSWORD = "correct horse battery staple";

class FakeStripeService {
  async createConnectAccount(_params: CreateConnectAccountParams): Promise<string> {
    return `acct_disabled_${randomUUID()}`;
  }
  async getAccountStatus(_accountId: string): Promise<ConnectAccountStatus> {
    return { cardPaymentsStatus: "active", payoutsStatus: "active", requirementsDue: [] };
  }
  async createAccountLink(_accountId: string): Promise<string> {
    return "https://connect.stripe.test/never-followed";
  }
  async createPaymentIntent(_params: CreatePaymentIntentParams): Promise<CreatedPaymentIntent> {
    return {
      id: `pi_disabled_${randomUUID()}`,
      clientSecret: "cs_disabled_never_used",
      amount: 0,
      currency: "eur",
    };
  }
}

describe("A disabled Membership (E2E, real HTTP, real database)", () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  let ownerToken: string;
  let staffEmail: string;
  let staffTokenBeforeDisable: string;
  let staffMembershipId: string;
  let restaurantId: string;

  async function registerAndLogin(label: string): Promise<{ email: string; accessToken: string }> {
    const email = `disabled-${label}-${randomUUID()}@example.com`;
    await request(app.getHttpServer()).post("/api/v1/auth/register").send({
      email,
      password: PASSWORD,
      displayName: label,
      locale: "en",
      acceptedTermsVersion: PLATFORM_TERMS_PLACEHOLDER,
    });
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { email, accessToken: login.body.data.accessToken as string };
  }

  async function resetRateLimits(): Promise<void> {
    // Deleting by prefix, never FLUSHALL — token revocation lives in the same Redis under `auth:`
    // and a blanket flush would silently un-revoke it.
    const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    try {
      const keys = await client.keys("throttle:*");
      if (keys.length > 0) await client.del(...keys);
    } finally {
      await client.quit();
    }
  }

  /**
   * Returns the status AND the refusal reason. It used to return the status alone, which is what
   * made `not.toBe(200)` the only assertion available here — and that passes on 500 and on the
   * route having been deleted, neither of which is a disabled Membership being refused.
   */
  async function readDashboard(token: string): Promise<{ status: number; code?: string }> {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/dashboard?restaurantId=${restaurantId}`)
      .set("Authorization", `Bearer ${token}`);
    return { status: res.status, code: (res.body as { error?: { code?: string } }).error?.code };
  }

  beforeAll(async () => {
    await resetRateLimits();
    await prisma.$connect();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StripeService)
      .useValue(new FakeStripeService())
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix("api/v1", { exclude: ["health", "webhooks/stripe"] });
    await app.init();

    const owner = await registerAndLogin("owner");
    ownerToken = owner.accessToken;

    const restaurant = await request(app.getHttpServer())
      .post("/api/v1/restaurants")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Disabled Membership Test",
        legalName: "Disabled Membership Test UAB",
        companyNumber: `DIS-${randomUUID()}`,
        vatNumber: `LT${Date.now()}`,
        email: `contact-${randomUUID()}@example.com`,
        phone: "+37060000000",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Gedimino pr. 1, Vilnius",
      });
    expect(restaurant.status, JSON.stringify(restaurant.body)).toBe(201);
    restaurantId = restaurant.body.data.id as string;

    // Manager, because the seeded Manager Role holds `reports.view` — the permission
    // `GET /dashboard` requires. Taken from the seeded Role, never a hand-written literal
    // (CLAUDE.md, Testing Philosophy): a literal cannot be wrong when written and cannot stay
    // right afterwards.
    const managerRole = await prisma.role.findUnique({ where: { name: "Manager" } });
    expect(managerRole, "the seeded Manager role must exist").toBeTruthy();

    const staff = await registerAndLogin("staff");
    staffEmail = staff.email;

    const invite = await request(app.getHttpServer())
      .post("/api/v1/memberships")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: staffEmail, restaurantId, roleId: managerRole!.id });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);

    const accept = await request(app.getHttpServer())
      .post("/api/v1/memberships/invitations/accept")
      .send({ email: staffEmail, token: (await readInvitationEmail(prisma, staffEmail)).token });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    staffMembershipId = accept.body.data.id as string;

    // Re-login so the token is issued against the Membership that now exists.
    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: staffEmail, password: PASSWORD });
    expect(relogin.status).toBe(200);
    staffTokenBeforeDisable = relogin.body.data.accessToken as string;
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await prisma.$disconnect();
  });

  it("the Manager can read the dashboard while ACTIVE — the half that makes the denial mean something", async () => {
    expect((await readDashboard(staffTokenBeforeDisable)).status).toBe(200);
  });

  it("disabling the Membership really does set it INACTIVE in the database", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/memberships/${staffMembershipId}/disable`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Read the row, not the response. The endpoint reporting success is not evidence the write
    // landed, and every assertion below is about what the Guard will read next.
    const row = await prisma.membership.findUniqueOrThrow({ where: { id: staffMembershipId } });
    expect(row.status).toBe("INACTIVE");
  });

  it("a DISABLED Membership must not still grant access — with a token minted after the disable", async () => {
    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: staffEmail, password: PASSWORD });
    expect(relogin.status).toBe(200);

    const refusal = await readDashboard(relogin.body.data.accessToken as string);
    expect(refusal.status, "a disabled Manager read the restaurant's dashboard").toBe(403);
    expect(refusal.code, "refused, but not for the reason this test is about").toBe(
      "PERMISSION_DENIED",
    );
  });

  it("a DISABLED Membership must not still grant access — with the token they already held", async () => {
    // The Guard re-reads Memberships from the database on every request, so the old token is not
    // a stale-cache excuse: this is the same query, run after the write, returning the same row.
    const refusal = await readDashboard(staffTokenBeforeDisable);
    expect(refusal.status, "a disabled Manager read the dashboard with their existing token").toBe(
      403,
    );
    expect(refusal.code, "refused, but not for the reason this test is about").toBe(
      "PERMISSION_DENIED",
    );
  });
});
