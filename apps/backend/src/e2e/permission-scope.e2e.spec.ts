import { randomUUID } from "node:crypto";
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

/**
 * Does a permission held in ONE Organization leak into a Restaurant in ANOTHER?
 *
 * `PermissionsGuard` answers only "does this user hold this permission on **any** Membership" —
 * its own comment says so, and marks the resource-scoped narrowing as an unbuilt "Sprint 3+"
 * extension point. We are in Sprint 14. That was reported as a possible hole, and reporting it
 * without evidence would have repeated the mistake that cost eleven days on `invalid_v2_key`, so
 * this file settles it by execution rather than by reading.
 *
 * The subject under test is a person who is genuinely both things at once:
 *   - **Owner** of Organization A — every permission, org-wide
 *   - **Waiter** at Restaurant B in Organization A2 — zero permissions, restaurant-scoped
 *
 * That is a real shape, not a contrivance: ADR-006 explicitly supports working at more than one
 * restaurant on the platform. It is also the exact shape that defeats a naive check, because the
 * permission and the reachability come from two different Memberships:
 *   - `PermissionsGuard` passes, on the strength of Organization A.
 *   - Reachability passes, on the strength of the Waiter Membership at Restaurant B.
 * Nothing in either check asks whether those are the **same** Membership.
 *
 * Both halves are asserted. A test that only proved the denial would pass equally against a
 * system that denies everything, so the same caller is also shown succeeding at their own
 * Restaurant A. Without that half, "403" proves nothing about scoping.
 */

const OWNER_PASSWORD = "correct horse battery staple";

class FakeStripeService {
  async createConnectAccount(_params: CreateConnectAccountParams): Promise<string> {
    return `acct_scope_${randomUUID()}`;
  }
  async getAccountStatus(_accountId: string): Promise<ConnectAccountStatus> {
    return { cardPaymentsStatus: "active", payoutsStatus: "active", requirementsDue: [] };
  }
  async createAccountLink(_accountId: string): Promise<string> {
    return "https://connect.stripe.test/never-followed";
  }
  async createPaymentIntent(_params: CreatePaymentIntentParams): Promise<CreatedPaymentIntent> {
    return {
      id: `pi_scope_${randomUUID()}`,
      clientSecret: "cs_scope_never_used",
      amount: 0,
      currency: "eur",
    };
  }
}

interface Actor {
  email: string;
  accessToken: string;
}

describe("Permission scope across Organizations (E2E, real HTTP, real database)", () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  let dualRole: Actor; // Owner in A, Waiter at Restaurant B
  let restaurantA: string; // reachable AND permitted for dualRole
  let restaurantB: string; // reachable, but only through a zero-permission Membership

  async function registerAndLogin(label: string): Promise<Actor> {
    const email = `scope-${label}-${randomUUID()}@example.com`;
    await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ email, password: OWNER_PASSWORD, displayName: label, locale: "en" });
    const login = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email, password: OWNER_PASSWORD });
    expect(login.status).toBe(200);
    return { email, accessToken: login.body.data.accessToken as string };
  }

  async function createRestaurant(actor: Actor, name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/api/v1/restaurants")
      .set("Authorization", `Bearer ${actor.accessToken}`)
      .send({
        name,
        legalName: `${name} UAB`,
        companyNumber: `SCOPE-${randomUUID()}`,
        vatNumber: `LT${Date.now()}`,
        email: `contact-${randomUUID()}@example.com`,
        phone: "+37060000000",
        country: "LT",
        currency: "EUR",
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Gedimino pr. 1, Vilnius",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  }

  /**
   * Clears rate-limit state before the fixture runs.
   *
   * Needed since ADR-042 moved the throttler's counter into Redis: it now survives a process
   * restart, so consecutive runs of this file share one budget and the second run fails on 429
   * during setup — which is exactly what happened, and reads as a broken test rather than an
   * exhausted budget. Deleting by prefix, never `FLUSHALL`: token revocation lives in the same
   * Redis under `auth:` and a blanket flush would silently un-revoke it.
   */
  async function resetRateLimits(): Promise<void> {
    const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    try {
      const keys = await client.keys("throttle:*");
      if (keys.length > 0) await client.del(...keys);
    } finally {
      await client.quit();
    }
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

    // Organization A — the subject owns it outright.
    dualRole = await registerAndLogin("dual");
    restaurantA = await createRestaurant(dualRole, "Scope Own Restaurant");

    // A second, unrelated Organization, owned by someone else. The subject is invited into it as
    // a Waiter — through the real invite and accept endpoints, so the Membership and its Role are
    // exactly what the product produces.
    const stranger = await registerAndLogin("stranger");
    restaurantB = await createRestaurant(stranger, "Scope Other Restaurant");

    const waiterRole = await prisma.role.findUnique({ where: { name: "Waiter" } });
    expect(waiterRole, "the seeded Waiter role must exist").toBeTruthy();

    const invite = await request(app.getHttpServer())
      .post("/api/v1/memberships")
      .set("Authorization", `Bearer ${stranger.accessToken}`)
      .send({ email: dualRole.email, restaurantId: restaurantB, roleId: waiterRole!.id });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);

    const accept = await request(app.getHttpServer())
      .post("/api/v1/memberships/invitations/accept")
      .send({ email: dualRole.email, token: invite.body.data.token });
    // Accept returns 200, not 201 — the Membership is created but the endpoint answers OK rather
    // than Created. Corrected from the real response rather than assumed.
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);

    // Re-login so the access token carries BOTH Memberships — this is the state under test.
    const relogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: dualRole.email, password: OWNER_PASSWORD });
    expect(relogin.status).toBe(200);
    dualRole.accessToken = relogin.body.data.accessToken as string;
    expect(
      relogin.body.data.memberships.length,
      "the subject must genuinely hold two Memberships for this test to mean anything",
    ).toBe(2);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await prisma.$disconnect();
  });

  it("the subject can read their OWN restaurant's dashboard — the half that makes the denial meaningful", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/dashboard?restaurantId=${restaurantA}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("a permission held in another Organization does NOT unlock the dashboard of a restaurant reached as a Waiter", async () => {
    // PermissionsGuard passes here — the subject holds `reports.view` via Organization A. The
    // question is whether anything downstream notices that the Membership reaching Restaurant B
    // is a different one, carrying no permissions at all.
    const res = await request(app.getHttpServer())
      .get(`/api/v1/dashboard?restaurantId=${restaurantB}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expect(res.status, `leaked: ${JSON.stringify(res.body)}`).not.toBe(200);
  });

  it("the same, for analytics revenue", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/analytics/revenue?restaurantId=${restaurantB}&from=2026-01-01&to=2026-12-31`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expect(res.status, `leaked: ${JSON.stringify(res.body)}`).not.toBe(200);
  });

  it("the same, for the transaction CSV export — asserted on the DATA, not the status code", async () => {
    // A 200 with an empty CSV would not be a leak, so this proves exposure rather than a status
    // code: a real Transaction is placed at Restaurant B and the export is checked for its id.
    //
    // The Payment and Transaction rows are written directly. Permitted under the same narrow rule
    // the e2e fixtures use: **the entity being created is not the subject of the check.** The
    // subject here is whether `data.export` held in one Organization reaches another's rows; the
    // Transaction is scenery, and driving a real payment plus its webhook would prove nothing
    // extra about permission scope.
    // `Payment.idempotencyKey` is a foreign key to `idempotency_keys`, not a free string — found
    // by the constraint rather than by reading the schema, and worth the row rather than working
    // around it: the FK is what makes an idempotent retry provable.
    const idempotencyKey = `scope-${randomUUID()}`;
    await prisma.idempotencyKey.create({
      data: {
        key: idempotencyKey,
        endpointScope: "POST /payments",
        requestFingerprint: "permission-scope-fixture",
        status: "COMPLETED",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        restaurantId: restaurantB,
        amount: 5000n,
        tipAmount: 0n,
        currency: "EUR",
        status: "SUCCEEDED",
        processor: "stripe",
        processorPaymentId: `pi_scope_${randomUUID()}`,
        paymentMethod: "card",
        idempotencyKey,
      },
    });
    const transaction = await prisma.transaction.create({
      data: {
        paymentId: payment.id,
        restaurantId: restaurantB,
        grossAmount: 5000n,
        currency: "EUR",
        status: "COMPLETED",
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/transactions/export?restaurantId=${restaurantB}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);

    expect(
      res.text.includes(transaction.id),
      "a zero-permission Waiter exported another restaurant's transaction row",
    ).toBe(false);
  });

  it("the PAYMENT list is scoped the same way — found by audit, not by this test reaching it first", async () => {
    // ADR-043. `GET /payments` had the identical shape and no permission decorator at all: a
    // Waiter saw the restaurant's full payment history, amounts and tips included. Added here so
    // the third instance is proved rather than asserted, and so a fix that only patched the two
    // transaction routes would be caught looking complete.
    const res = await request(app.getHttpServer())
      .get(`/api/v1/payments?restaurantId=${restaurantB}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    const ids: string[] = (res.body?.data?.data ?? []).map((p: { id: string }) => p.id);
    expect(ids.length, `leaked ${ids.length} payments: ${JSON.stringify(res.body)}`).toBe(0);
  });

  it("the transaction LIST leaks the same way if the export does — they share buildWhere", async () => {
    // Same predicate, different endpoint. Asserted separately so a fix that only patches the CSV
    // path is caught rather than looking complete.
    const res = await request(app.getHttpServer())
      .get(`/api/v1/transactions?restaurantId=${restaurantB}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    // The list is paginated: the envelope’s `data` holds `{ data, meta }`, not the array itself.
    const ids: string[] = (res.body?.data?.data ?? []).map((t: { id: string }) => t.id);
    expect(ids.length, `leaked ${ids.length} rows: ${JSON.stringify(res.body)}`).toBe(0);
  });

  it("the same, for taking a payment at someone else's restaurant", async () => {
    // The sharpest of the set: `payments.manage` held in Organization A must not let this person
    // create a charge on Restaurant B's Stripe account.
    const res = await request(app.getHttpServer())
      .post("/api/v1/payments")
      .set("Authorization", `Bearer ${dualRole.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ restaurantId: restaurantB, amount: 1000, tipAmount: 0 });
    expect(res.status, `leaked: ${JSON.stringify(res.body)}`).not.toBe(201);
  });

  it("the same, for inviting staff into someone else's restaurant", async () => {
    const waiterRole = await prisma.role.findUnique({ where: { name: "Waiter" } });
    const res = await request(app.getHttpServer())
      .post("/api/v1/memberships")
      .set("Authorization", `Bearer ${dualRole.accessToken}`)
      .send({
        email: `scope-victim-${randomUUID()}@example.com`,
        restaurantId: restaurantB,
        roleId: waiterRole!.id,
      });
    expect(res.status, `leaked: ${JSON.stringify(res.body)}`).not.toBe(201);
  });
});
