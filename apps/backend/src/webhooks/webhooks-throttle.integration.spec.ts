import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

// Sprint 11 (ADR-028): confirms the route's new 500/min override actually took effect — raised
// from the 100/min baseline, not tightened, per the Founder's own instruction to check whether the
// baseline was too low for Stripe's real, IP-pool-shared webhook traffic rather than assuming it
// needed tightening the way every other route in this sprint did. Only proves the ceiling moved;
// doesn't re-prove signature verification (webhooks.service.spec.ts's own job).
describe("WebhooksController — stripe throttle (integration)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fakeWebhooksService = {
      handleEvent: vi.fn().mockResolvedValue({ received: true }),
    };

    const moduleRef = await Test.createTestingModule({
      // A LOWER global default than the route's own 500/min override, deliberately: if the
      // route-level @Throttle decorator were ever removed, every one of these 150 calls would
      // start failing at the global default instead, making a regression here loud, not silent.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [WebhooksController],
      providers: [
        { provide: WebhooksService, useValue: fakeWebhooksService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows well past the 100/min global baseline, proving the route's own 500/min override is active", async () => {
    for (let i = 0; i < 150; i++) {
      const res = await request(app.getHttpServer())
        .post("/webhooks/stripe")
        .set("stripe-signature", "whatever-not-checked")
        .send({ id: `evt_${i}` });
      expect(res.status).not.toBe(429);
    }
  });
});
