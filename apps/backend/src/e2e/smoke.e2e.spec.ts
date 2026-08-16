import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";

// IMPLEMENTATION_PLAN.md, Sprint 12: "Smoke tests." Deliberately shallow and fast, distinct from
// critical-flow.e2e.spec.ts's own deep single flow — the question here is only "does the app boot
// and answer at all," the same question a deploy-time healthcheck asks, not "is business logic
// correct." No StripeService override: nothing here reaches a route that constructs a
// PaymentIntent or Connect account, so the real (unused) provider is fine as-is.
describe("Smoke (E2E, app boots and answers)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix("api/v1", { exclude: ["health", "webhooks/stripe"] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health reports ok with real database and Redis connectivity", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { database: "ok", redis: "ok" } });
  });

  it("an unauthenticated request to a protected route is rejected, not crashed", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/wallets");
    expect(res.status).toBe(401);
  });

  it("an unknown route returns 404, not a silent success", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/this-route-does-not-exist");
    expect(res.status).toBe(404);
  });
});
