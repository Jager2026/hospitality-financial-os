import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RestaurantController } from "./restaurant.controller";
import { RestaurantService } from "./restaurant.service";

// Sprint 11 (ADR-028): same precedent as auth-throttle.integration.spec.ts. POST /restaurants is
// the cheapest spam/resource-exhaustion target in the API — no PermissionsGuard at all (a fresh
// user with zero Memberships must be able to call it), and every real call creates a genuine
// Stripe Connect account — hence the new 5/min override. JwtAuthGuard is overridden (not faked
// out with empty dependencies) because this route actually requires an authenticated
// request.user, unlike the public routes the two existing throttle specs cover.
describe("RestaurantController — create throttle (integration)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fakeRestaurantService = {
      create: vi.fn().mockResolvedValue({ id: randomUUID() }),
      createOnboardingLink: vi.fn().mockResolvedValue("https://connect.stripe.com/setup/s/fake"),
    };
    const fakeAuthGuard: CanActivate = {
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        req.user = { id: randomUUID(), email: "owner@example.com", locale: "en", memberships: [] };
        return true;
      },
    };

    const moduleRef = await Test.createTestingModule({
      // Same global default as app.module.ts (100/min) — the point is confirming the route-level
      // override to 5/min actually takes effect, not the global fallback.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [RestaurantController],
      providers: [
        { provide: RestaurantService, useValue: fakeRestaurantService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows exactly 5/min and rejects the 6th with 429", async () => {
    const body = {
      name: "Test",
      legalName: "Test UAB",
      companyNumber: "123",
      vatNumber: "LT123",
      email: "restaurant@example.com",
      phone: "+37060000000",
      country: "LT",
      currency: "EUR",
      timezone: "Europe/Vilnius",
      address: "Test address",
    };

    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer()).post("/restaurants").send(body);
      expect(res.status).not.toBe(429);
    }

    const sixth = await request(app.getHttpServer()).post("/restaurants").send(body);
    expect(sixth.status).toBe(429);
  });

  /**
   * THREAT_MODEL (#118), measure 3 — and one test rather than two, because the two halves have to
   * run in one order to mean anything. `ThrottlerGuard` keys its buckets by tracker + handler,
   * **not by URL**, so a second test would inherit whatever budget the first had spent.
   *
   * The permission (measure 1) does not close this: an Owner legitimately holds the right and can
   * still mint an unbounded series, and mail clients burn links by following them to scan. A
   * link's measured lifetime is five minutes (real test account, 2026-09-02), so ten per hour is
   * past any honest need and still a number rather than "unlimited".
   */
  it("gives the onboarding-link route its own bucket of 10/hour, separate from POST /restaurants", async () => {
    // POST /restaurants is already spent by the test above. Confirmed rather than assumed,
    // because the next assertion means nothing unless this one holds.
    const exhausted = await request(app.getHttpServer()).post("/restaurants").send({ name: "T" });
    expect(exhausted.status).toBe(429);

    // The discriminating half. A naive single shared bucket would refuse this — and would refuse
    // a legitimate owner who had merely created a venue first. This is the case where the shared
    // and per-route implementations disagree; without it, the count below would pass against both.
    const first = await request(app.getHttpServer())
      .post(`/restaurants/${randomUUID()}/onboarding-link`)
      .send({});
    expect(first.status).not.toBe(429);

    // Nine more, for ten in total on this route's own bucket.
    for (let i = 0; i < 9; i++) {
      const res = await request(app.getHttpServer())
        .post(`/restaurants/${randomUUID()}/onboarding-link`)
        .send({});
      expect(res.status).not.toBe(429);
    }

    // The eleventh is the cap. A different venue id on purpose: the bucket is per route and
    // caller, not per venue, so changing the id must not buy another ten.
    const eleventh = await request(app.getHttpServer())
      .post(`/restaurants/${randomUUID()}/onboarding-link`)
      .send({});
    expect(eleventh.status).toBe(429);
  });
});
