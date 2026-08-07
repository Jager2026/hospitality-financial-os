import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

// Founder review (post-Sprint-5 coverage audit): WebhooksController had 0% coverage, including
// its own `if (!req.rawBody)` guard — the exact check that would catch main.ts's `rawBody: true`
// ever being removed or broken in a future refactor. Real controller, faked WebhooksService (the
// service's own logic is covered on its own terms in webhooks.service.spec.ts); this app is built
// WITHOUT `rawBody: true` specifically, to genuinely reproduce the misconfiguration the guard
// exists to catch, rather than asserting on the branch by reading the code.
describe("WebhooksController — missing raw body (app built without rawBody:true)", () => {
  let app: INestApplication;
  const fakeWebhooksService = { handleEvent: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [{ provide: WebhooksService, useValue: fakeWebhooksService }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects with 400 before ever calling WebhooksService, when req.rawBody is missing", async () => {
    const res = await request(app.getHttpServer())
      .post("/webhooks/stripe")
      .set("Stripe-Signature", "t=1,v1=irrelevant-never-checked")
      .send({ type: "payment_intent.succeeded" });

    expect(res.status).toBe(400);
    expect(fakeWebhooksService.handleEvent).not.toHaveBeenCalled();
  });
});

describe("WebhooksController — raw body present (app built WITH rawBody:true)", () => {
  let app: INestApplication;
  const fakeWebhooksService = { handleEvent: vi.fn().mockResolvedValue({ received: true }) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [{ provide: WebhooksService, useValue: fakeWebhooksService }],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterEach(() => {
    fakeWebhooksService.handleEvent.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it("passes the exact raw body bytes and the Stripe-Signature header through to WebhooksService", async () => {
    const signature = "t=1,v1=a-real-looking-signature-value";
    const res = await request(app.getHttpServer())
      .post("/webhooks/stripe")
      .set("Stripe-Signature", signature)
      .send({ type: "payment_intent.succeeded", id: "evt_test" });

    expect(res.status).toBe(200);
    expect(fakeWebhooksService.handleEvent).toHaveBeenCalledTimes(1);
    const [rawBodyArg, signatureArg] = fakeWebhooksService.handleEvent.mock.calls[0];
    expect(Buffer.isBuffer(rawBodyArg)).toBe(true);
    expect(JSON.parse(rawBodyArg.toString())).toMatchObject({ type: "payment_intent.succeeded" });
    expect(signatureArg).toBe(signature);
  });
});
