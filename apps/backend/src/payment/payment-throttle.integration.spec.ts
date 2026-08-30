import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { syntheticCaller } from "../../test/fixtures/authenticated-user";

// Sprint 11 (ADR-028): same precedent as auth-throttle.integration.spec.ts. POST /payments creates
// a real Stripe PaymentIntent per call and is the shape card-testing fraud targets — hence the new
// 20/min override. Exercises the real IdempotencyInterceptor too (ADR-004 requires an
// Idempotency-Key on this route), with PrismaService's idempotencyKey methods faked to always
// treat the key as new, since the point here is the throttle limit, not idempotency behavior
// itself (already covered by its own tests).
describe("PaymentController — create throttle (integration)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fakePaymentService = {
      createPaymentIntent: vi.fn().mockResolvedValue({ id: randomUUID() }),
    };
    const fakePrisma = {
      idempotencyKey: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const fakeAuthGuard: CanActivate = {
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        // Synthetic on purpose — see membership-throttle.integration.spec.ts. The identity is
        // scaffolding for a rate-limit assertion, not a claim about the Owner Role.
        req.user = syntheticCaller({
          permissions: ["payments.manage"],
          organizationId: randomUUID(),
          restaurantId: null,
          email: "manager@example.com",
        });
        return true;
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: fakePaymentService },
        { provide: PrismaService, useValue: fakePrisma },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        PermissionsGuard,
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

  it("allows exactly 20/min and rejects the 21st with 429", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await request(app.getHttpServer())
        .post("/payments")
        .set("Idempotency-Key", `key-${i}`)
        .send({ restaurantId: randomUUID(), amount: 1000 });
      expect(res.status).not.toBe(429);
    }

    const twentyFirst = await request(app.getHttpServer())
      .post("/payments")
      .set("Idempotency-Key", "key-20")
      .send({ restaurantId: randomUUID(), amount: 1000 });
    expect(twentyFirst.status).toBe(429);
  });
});
