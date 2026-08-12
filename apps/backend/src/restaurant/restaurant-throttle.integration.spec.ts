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
});
