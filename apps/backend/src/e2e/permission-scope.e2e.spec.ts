import { randomUUID } from "node:crypto";
import { CURRENT_STRIPE_AGREEMENT_VERSION } from "../common/agreements/agreement-versions";
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

/**
 * A refusal asserted by the status AND the reason, because in this suite the two answer different
 * questions and only one of them is about permissions.
 *
 * **Why not `not.toBe(200)`, which is what every one of these assertions used to say.** It passes
 * on 403, which is intended — and equally on 404, 500, 502, and on the route having been deleted.
 * A regression turning a clean refusal into a crash passed. Removing the route passed. A test that
 * still passes when the feature under test is deleted proves nothing about the feature.
 *
 * **Why the code and not only the status.** 403 and 404 are not interchangeable here, and which one
 * is correct is a disclosure decision rather than a style choice (`THREAT_MODEL.md` entry 296):
 *
 *   - **403 `PERMISSION_DENIED`** — the caller can already see that the resource exists, because
 *     they hold a Membership at that Restaurant. Nothing is disclosed by saying no; what is missing
 *     is a Permission.
 *   - **404 `PAYMENT_NOT_FOUND` / `NOT_FOUND`** — the caller may not read that Restaurant at all,
 *     so *confirming the row exists is itself the disclosure*. The refusal must be
 *     indistinguishable from the row not existing, which is the same answer the list already gives
 *     by omitting it.
 *
 * Asserting the status alone would let a 404 for the wrong reason — a mistyped id, a route that
 * quietly stopped existing — stand in for the deliberate one. The code pins the reason.
 */
function expectRefused(
  res: { status: number; body: unknown },
  status: 403 | 404,
  code: "PERMISSION_DENIED" | "PAYMENT_NOT_FOUND" | "NOT_FOUND",
): void {
  const body = res.body as { error?: { code?: string } };
  expect(res.status, `expected a refusal, got: ${JSON.stringify(res.body)}`).toBe(status);
  expect(body.error?.code, `refused with the wrong reason: ${JSON.stringify(res.body)}`).toBe(code);
}

describe("Permission scope across Organizations (E2E, real HTTP, real database)", () => {
  const prisma = new PrismaService();
  let app: INestApplication;

  let dualRole: Actor; // Owner in A, Waiter at Restaurant B
  let restaurantA: string; // reachable AND permitted for dualRole
  let restaurantB: string; // reachable, but only through a zero-permission Membership

  // A Payment and a Transaction that genuinely belong to Restaurant B, so the by-id reads below
  // ask about a real row rather than a missing one — a 404 for "no such row" would look exactly
  // like a 404 for "not yours", and the whole measurement turns on telling those apart.
  //
  // The Payment is created through the REAL endpoint by B's own Owner rather than seeded:
  // `Payment.idempotencyKey` is a foreign key into the idempotency table, so a hand-built row is
  // not merely inauthentic, it cannot exist. The Transaction is seeded, and its shape was wrong
  // on the first attempt — four fields that do not exist on the model. Caught by the database
  // rejecting it, which is the only reason it did not become a fixture describing a system that
  // is not this one.
  let pureWaiter: Actor; // ONLY a zero-permission Waiter at B — holds reports.view nowhere
  let stranger: Actor; // Owner of Restaurant B, used to create B's own rows through the real API
  let paymentAtB: string;
  let transactionAtB: string;

  async function registerAndLogin(label: string): Promise<Actor> {
    const email = `scope-${label}-${randomUUID()}@example.com`;
    await request(app.getHttpServer()).post("/api/v1/auth/register").send({
      email,
      password: OWNER_PASSWORD,
      displayName: label,
      locale: "en",
      acceptedTermsVersion: PLATFORM_TERMS_PLACEHOLDER,
    });
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
        acceptedStripeAgreementVersion: CURRENT_STRIPE_AGREEMENT_VERSION,
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
    stranger = await registerAndLogin("stranger");
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
      .send({
        email: dualRole.email,
        token: (await readInvitationEmail(prisma, dualRole.email)).token,
      });
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

    // A THIRD subject, and the only one who holds `reports.view` nowhere at all.
    //
    // `dualRole` cannot measure the guard: they are an Owner in Organization A, so the coarse
    // filter passes them and every refusal below comes from a service. This person's single
    // Membership is the zero-permission Waiter at Restaurant B — the actor ADR-079's table used,
    // and the only one whose answer changes if the guard is unwired.
    //
    // Registered WITHOUT the usual `registerAndLogin`, and the reason is a 429 this fixture hit on
    // its first run. `/api/v1/auth/*` allows ten calls a minute per IP, the whole suite shares one
    // IP through Redis (ADR-042), and `auth-throttle.integration.spec.ts` deliberately exhausts
    // that budget from a parallel worker. A third subject took this file's own setup from five
    // auth calls to eight and the collision became likely rather than possible.
    //
    // The budget is reset again here — the same mechanism this file already uses once, applied at
    // the point the calls are actually made — and the login this subject does not need is dropped:
    // `registerAndLogin` signs in immediately, but the only token wanted is the one issued AFTER
    // the invitation is accepted, since a token minted before it carries no Membership.
    await resetRateLimits();
    const waiterEmail = `scope-waiter-only-${randomUUID()}@example.com`;
    const waiterRegistration = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        email: waiterEmail,
        password: OWNER_PASSWORD,
        displayName: "waiter-only",
        locale: "en",
        acceptedTermsVersion: PLATFORM_TERMS_PLACEHOLDER,
      });
    expect(waiterRegistration.status, JSON.stringify(waiterRegistration.body)).toBe(201);
    pureWaiter = { email: waiterEmail, accessToken: "" };
    const inviteWaiter = await request(app.getHttpServer())
      .post("/api/v1/memberships")
      .set("Authorization", `Bearer ${stranger.accessToken}`)
      .send({ email: pureWaiter.email, restaurantId: restaurantB, roleId: waiterRole!.id });
    expect(inviteWaiter.status, JSON.stringify(inviteWaiter.body)).toBe(201);
    const acceptWaiter = await request(app.getHttpServer())
      .post("/api/v1/memberships/invitations/accept")
      .send({
        email: pureWaiter.email,
        token: (await readInvitationEmail(prisma, pureWaiter.email)).token,
      });
    expect(acceptWaiter.status, JSON.stringify(acceptWaiter.body)).toBe(200);
    const waiterLogin = await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .send({ email: pureWaiter.email, password: OWNER_PASSWORD });
    expect(
      waiterLogin.body.data.memberships.length,
      "exactly one Membership, or this subject is not the one the measurement needs",
    ).toBe(1);
    pureWaiter.accessToken = waiterLogin.body.data.accessToken as string;

    // Created through the REAL endpoint by B's own Owner. `Payment.idempotencyKey` is a foreign
    // key into the idempotency table, so a hand-seeded row is not merely inconvenient — it cannot
    // exist. Going through the endpoint also means the row is exactly what the product produces.
    const createdAtB = await request(app.getHttpServer())
      .post("/api/v1/payments")
      .set("Authorization", `Bearer ${stranger.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ restaurantId: restaurantB, amount: 5000, tipAmount: 0 });
    expect(createdAtB.status, JSON.stringify(createdAtB.body)).toBe(201);
    paymentAtB = createdAtB.body.data.id as string;

    const transaction = await prisma.transaction.create({
      data: {
        paymentId: paymentAtB,
        restaurantId: restaurantB,
        grossAmount: 5000n,
        currency: "EUR",
        status: "COMPLETED",
      },
    });
    transactionAtB = transaction.id;
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
    expectRefused(res, 403, "PERMISSION_DENIED");
  });

  it("the same, for analytics revenue", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/analytics/revenue?restaurantId=${restaurantB}&from=2026-01-01&to=2026-12-31`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expectRefused(res, 403, "PERMISSION_DENIED");
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

  it("the same, for taking a payment at someone else's restaurant — and for the RIGHT reason", async () => {
    // The sharpest of the set: `payments.manage` held in Organization A must not let this person
    // create a charge on Restaurant B's Stripe account.
    const res = await request(app.getHttpServer())
      .post("/api/v1/payments")
      .set("Authorization", `Bearer ${dualRole.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ restaurantId: restaurantB, amount: 1000, tipAmount: 0 });
    expectRefused(res, 403, "PERMISSION_DENIED");

    // `not.toBe(201)` was the whole assertion until now, and it is not enough. This route's
    // service checks REACHABILITY, not the permission at the target restaurant, and the caller is
    // genuinely reachable at B through the Waiter Membership — so a refusal here could equally
    // well be an unrelated 400 (an un-onboarded Stripe account, a currency mismatch), leaving the
    // test green while the scoping it claims to prove does not exist.
    //
    // Asserting the reason is what separates "denied" from "happened to fail". A status of 400
    // fails this deliberately: it would mean the protection is a side effect of setup, not a rule.
    expect(
      [403, 404],
      `refused, but for an unrelated reason — status ${res.status}, body ${JSON.stringify(res.body)}`,
    ).toContain(res.status);
  });

  // ─── The by-id reads, and a comment that outlived the state it described ────────────────────
  //
  // This block used to open "three routes carrying NO @RequirePermission at all", and go on to say
  // they were "guarded by JwtAuthGuard alone" with "no coarse permission check above them to be
  // doubled". Both halves stopped being true, at different moments, and nothing noticed either.
  //
  // The decorator arrived with #108's fix, which gave all three `@RequirePermission("reports.view")`
  // — so the first half was already false when it was last read. The second half was true for a
  // worse reason: the decorator was there and **nothing read it**. `PermissionsGuard` is not
  // global, and neither controller named it in a `@UseGuards`, so the route advertised a
  // requirement the framework never imposed. ADR-079 measured that; this PR wired the guard onto
  // both controllers.
  //
  // The comment is rewritten rather than deleted because its being wrong is the finding: prose
  // describing a protection is exactly the artefact that cannot be trusted to age, which is why
  // the enforcement question now belongs to an invariant (`repo-invariants.spec.ts`) and to the
  // executable test at the end of this file rather than to a paragraph.
  //
  // What holds today: reachability inside the services is still the decision (ADR-043) — the
  // guard is a coarse pre-filter that asks only whether the caller holds `reports.view` on ANY
  // Membership. The three tests below are unchanged and still pass, because their subject is an
  // Owner in Organization A and therefore clears the coarse filter; what refuses them is the
  // service, exactly as before.

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // These three were `it.fails` for exactly one PR, and the mechanism worked as designed.
  //
  // PR #108 measured the leak: all three returned **200** with a full body to a caller whose only
  // relationship to Restaurant B was a zero-permission Waiter Membership. `GET /payments/:id`
  // gave amount, tip, currency, processor id and idempotency key; `GET /transactions/:id` gave
  // gross, net revenue, net tip, net platform fee, tax, refunds and chargebacks. They were
  // recorded as `it.fails` — asserting the CORRECT behaviour, marked as currently failing — so
  // that CI stayed green while the finding sat in THREAT_MODEL awaiting a decision, and so that
  // closing the leak would make them fail with "expected to fail but passed".
  //
  // That is what happened. The marker destroyed itself on success and forced this edit, which is
  // the whole argument for `it.fails` over `it.skip`: a skipped test is invisible and rots, while
  // this one had a deadline it enforced on its own.
  //
  // They are ordinary tests now. `hasPermissionAtRestaurant` — the same predicate `permittedScope`
  // filters the list routes with — is what closes it, so the by-id read and the list answer one
  // question one way.
  it("a payment at a restaurant reached only as a zero-permission Waiter is not readable by id", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/payments/${paymentAtB}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expectRefused(res, 404, "PAYMENT_NOT_FOUND");
  });

  it("nor is its status", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/payments/${paymentAtB}/status`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expectRefused(res, 404, "PAYMENT_NOT_FOUND");
  });

  it("nor the transaction behind it", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${transactionAtB}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expectRefused(res, 404, "NOT_FOUND");
  });

  it("but the SAME reads succeed at the caller's own restaurant — without this, the three above prove nothing", async () => {
    // A route that refused everything would satisfy all three denials, and a route that answered
    // everything satisfies this one. Together they say the three above are measuring scope rather
    // than a broken route — which matters more than usual here, because those three are currently
    // recording a leak and a reader must be able to tell a leak from a misconfigured fixture.
    const own = await request(app.getHttpServer())
      .post("/api/v1/payments")
      .set("Authorization", `Bearer ${dualRole.accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ restaurantId: restaurantA, amount: 5000, tipAmount: 0 });
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/payments/${own.body.data.id as string}`)
      .set("Authorization", `Bearer ${dualRole.accessToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  // ─── The guard itself, measured rather than read ─────────────────────────────────────────────
  //
  // Everything above is answered by a service. This is the one test in the file whose answer comes
  // from `PermissionsGuard`, and it exists because the decorator on these three routes spent an
  // unknown number of sprints doing nothing while every audit reported them as guarded (ADR-079).
  //
  // **Why it is not redundant with the repository invariant.** That invariant reads source text
  // and can only ever prove a `@UseGuards` is WRITTEN. This one issues a request and proves it
  // RUNS — the distinction the whole finding turned on.
  //
  // Both ways of breaking it were executed, and the second corrected what this comment claimed on
  // its first draft. Unwire the class guard: 403 becomes **404**, the service refusing instead.
  // Remove `@RequirePermission` and keep the guard: also **404**, for the same reason — the guess
  // written here first was 200, and it was wrong, because `PaymentService` checks `reports.view`
  // at the restaurant itself (ADR-043) and needs no decorator to refuse.
  //
  // So what this pins is not "the route is closed": it was closed throughout ADR-079's whole
  // measurement, which is exactly why an inert decorator leaked nothing. It pins **which layer
  // closes it** — a 403 means the coarse pre-filter ran, a 404 means only the service stood
  // between this caller and the data. Nothing else in the suite can tell those two apart.
  it("refuses a caller who holds `reports.view` on no Membership — the guard, not the service", async () => {
    for (const route of [
      `/api/v1/payments/${paymentAtB}`,
      `/api/v1/payments/${paymentAtB}/status`,
      `/api/v1/transactions/${transactionAtB}`,
    ]) {
      const res = await request(app.getHttpServer())
        .get(route)
        .set("Authorization", `Bearer ${pureWaiter.accessToken}`);
      expectRefused(res, 403, "PERMISSION_DENIED");
    }
  });

  it("and refuses identically for an id that does not exist — the 403 is about the caller, not the row", async () => {
    // The half that makes the test above safe rather than merely green. 403 where 404 used to be
    // is a real change in what a refused caller is told, and this file's own doctrine says the two
    // are not interchangeable: 403 concedes that the resource exists, 404 does not.
    //
    // It is not a disclosure HERE, and the reason is that the guard runs before the service and
    // never looks at the id. A nonexistent id must therefore produce the same 403, byte for byte —
    // if it ever produced 404 instead, the pair would become an existence oracle for a caller with
    // no permission at all, and this assertion is what would fail.
    const ghost = randomUUID();
    for (const route of [`/api/v1/payments/${ghost}`, `/api/v1/transactions/${ghost}`]) {
      const res = await request(app.getHttpServer())
        .get(route)
        .set("Authorization", `Bearer ${pureWaiter.accessToken}`);
      expectRefused(res, 403, "PERMISSION_DENIED");
    }
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
    expectRefused(res, 403, "PERMISSION_DENIED");
  });
});
