import { randomUUID } from "node:crypto";
import { Body, Controller, HttpCode, HttpStatus, Post, UseInterceptors } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

@Controller("idempotency-race-test")
class IdempotencyRaceTestController {
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  create(@Body() body: { label: string }) {
    return { id: randomUUID(), label: body.label };
  }
}

// THREAT_MODEL.md: IdempotencyInterceptor.intercept()'s findUnique-then-create shape has a real
// gap between the read and the write — two requests can both see "no existing key" before either
// create() lands, and only one create() can actually win the database's own unique constraint.
// Deliberately not a real-concurrency (Promise.all) test: ADR-030's own load test already fired 15
// genuinely concurrent requests and got a clean split THAT RUN — proving the race window is narrow
// enough that natural timing alone doesn't reliably trigger it, which is exactly what makes such a
// test non-discriminating (CLAUDE.md: a test only counts if a plausible wrong implementation could
// fail it). Instead, forced deterministically: pre-create the row for this key directly (simulating
// "someone else's create() already won"), then spy findUnique() to return null anyway (simulating
// "my own read raced ahead and didn't see it yet") — this makes THIS request's own create() hit a
// REAL Postgres unique-constraint violation on every single run, not just sometimes.
describe("IdempotencyInterceptor — concurrent-create race (real database)", () => {
  let app: INestApplication;
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      controllers: [IdempotencyRaceTestController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("a lost create()-vs-create() race is converted to a controlled 409 IDEMPOTENCY_KEY_CONFLICT, not a raw 500 — discriminating: the pre-fix code let this specific error propagate unhandled", async () => {
    const key = `race-key-${randomUUID()}`;

    // The "winner" — a real row already exists for this key before our request even starts.
    await prisma.idempotencyKey.create({
      data: {
        key,
        endpointScope: "/idempotency-race-test",
        requestFingerprint: "irrelevant-for-this-test",
        status: "IN_PROGRESS",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // Forces THIS request down the "!existing" branch anyway, exactly as if its own findUnique()
    // had raced ahead of the winner's create() — its own create() call is real, unmocked, and
    // will hit the real unique constraint above.
    vi.spyOn(prisma.idempotencyKey, "findUnique").mockResolvedValueOnce(null);

    const response = await request(app.getHttpServer())
      .post("/idempotency-race-test")
      .set("Idempotency-Key", key)
      .send({ label: "loser" });

    expect(response.status).toBe(409);
    expect(response.body.code ?? response.body.error?.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("an unrelated Prisma error during create() is NOT swallowed as a 409 — discriminating: a naive catch-all (matching claimEvent()'s own looser pattern) would also convert this", async () => {
    const key = `race-key-unrelated-error-${randomUUID()}`;
    vi.spyOn(prisma.idempotencyKey, "findUnique").mockResolvedValueOnce(null);
    vi.spyOn(prisma.idempotencyKey, "create").mockRejectedValueOnce(
      new Error("simulated unrelated database failure"),
    );

    const response = await request(app.getHttpServer())
      .post("/idempotency-race-test")
      .set("Idempotency-Key", key)
      .send({ label: "should not be treated as a conflict" });

    expect(response.status).toBe(500);
    expect(response.body.code ?? response.body.error?.code).not.toBe("IDEMPOTENCY_KEY_CONFLICT");
  });
});
