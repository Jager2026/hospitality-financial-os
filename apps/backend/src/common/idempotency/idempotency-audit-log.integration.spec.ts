import { randomUUID } from "node:crypto";
import { Body, Controller, HttpCode, HttpStatus, Post, UseInterceptors } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditEntity } from "../decorators/audit-entity.decorator";
import { AuditLogInterceptor } from "../interceptors/audit-log.interceptor";
import { PrismaService } from "../../prisma/prisma.service";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

// Minimal controller exercising the exact interceptor chain a real financial endpoint uses
// (APP_INTERCEPTOR AuditLogInterceptor wrapping a route-level IdempotencyInterceptor) — proves
// the Sprint 5 DoD fix against the real interceptor classes, real database, real HTTP request
// cycle, not a re-declared copy of the ordering that could silently drift from the real one.
@Controller("idempotency-audit-test")
class IdempotencyAuditTestController {
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(IdempotencyInterceptor)
  @AuditEntity("IdempotencyAuditTest")
  create(@Body() body: { label: string }) {
    return { id: randomUUID(), label: body.label };
  }
}

describe("IdempotencyInterceptor + AuditLogInterceptor (real database, integration)", () => {
  let app: INestApplication;
  const prisma = new PrismaService();

  beforeAll(async () => {
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      controllers: [IdempotencyAuditTestController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: PinoLogger,
          useValue: { setContext: () => {}, warn: () => {} } as unknown as PinoLogger,
        },
        { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("a replayed idempotent request produces exactly one AuditLog row, not two", async () => {
    const key = `test-key-${randomUUID()}`;
    const body = { label: "first attempt" };

    const first = await request(app.getHttpServer())
      .post("/idempotency-audit-test")
      .set("Idempotency-Key", key)
      .send(body);
    expect(first.status).toBe(201);

    // Fires immediately after the first response — this is exactly the race the runHandler()
    // fix (awaiting the COMPLETED update instead of a fire-and-forget write) protects against:
    // without it, this could hit the concurrent-duplicate 409 branch instead of a true replay.
    const second = await request(app.getHttpServer())
      .post("/idempotency-audit-test")
      .set("Idempotency-Key", key)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body); // genuinely replayed, not re-run with a new id

    const auditRows = await prisma.auditLog.findMany({ where: { entityId: first.body.id } });
    expect(auditRows).toHaveLength(1);
  });

  it("two DIFFERENT Idempotency-Keys each produce their own AuditLog row — not globally suppressed", async () => {
    // Discriminating case: a naive fix that skips AuditLogInterceptor's write whenever
    // IdempotencyInterceptor is anywhere in the chain (rather than only on an actual replay)
    // would pass the test above but incorrectly fail this one.
    const first = await request(app.getHttpServer())
      .post("/idempotency-audit-test")
      .set("Idempotency-Key", `key-a-${randomUUID()}`)
      .send({ label: "a" });
    const second = await request(app.getHttpServer())
      .post("/idempotency-audit-test")
      .set("Idempotency-Key", `key-b-${randomUUID()}`)
      .send({ label: "b" });

    expect(first.body.id).not.toBe(second.body.id);

    const rowsA = await prisma.auditLog.findMany({ where: { entityId: first.body.id } });
    const rowsB = await prisma.auditLog.findMany({ where: { entityId: second.body.id } });
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
  });

  it("a request reusing the same key with a DIFFERENT body is rejected, not replayed or logged again", async () => {
    const key = `test-key-conflict-${randomUUID()}`;

    const first = await request(app.getHttpServer())
      .post("/idempotency-audit-test")
      .set("Idempotency-Key", key)
      .send({ label: "original" });
    expect(first.status).toBe(201);

    const conflicting = await request(app.getHttpServer())
      .post("/idempotency-audit-test")
      .set("Idempotency-Key", key)
      .send({ label: "different body" });
    expect(conflicting.status).toBe(409);

    // The conflict is rejected before the handler ever runs — no second AuditLog row for the
    // original entity, and the rejection itself has no entity id to log against.
    const auditRows = await prisma.auditLog.findMany({ where: { entityId: first.body.id } });
    expect(auditRows).toHaveLength(1);
  });
});
