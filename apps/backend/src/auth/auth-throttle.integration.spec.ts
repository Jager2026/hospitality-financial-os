import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { TokenService } from "./token.service";

// DoD (IMPLEMENTATION_PLAN.md, Sprint 2): "A brute-force attempt is throttled." Exercises the
// REAL AuthController class and its real `@Throttle({ limit: 10, ttl: 60_000 })` decorator
// (API_Contract.md, Rate Limiting: "Authentication 10/min") through an actual HTTP request cycle
// — not a re-declared copy of the config that could silently drift from the real one. Only ever
// confirmed manually via curl before now.
describe("AuthController — throttle (integration)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fakeAuthService = {
      login: vi.fn().mockRejectedValue(new Error("not reached before the limit")),
      register: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      // Same global default as app.module.ts (100/min) — the point is confirming
      // AuthController's own override to 10/min actually takes effect, not the global fallback.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: fakeAuthService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        // Never exercised by this test (only /auth/login is called) — needed only because
        // AuthController also declares /auth/me with @UseGuards(JwtAuthGuard), and Nest
        // constructs every guard referenced anywhere in the module at compile time, regardless
        // of which route a given test actually calls.
        { provide: TokenService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        JwtAuthGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows exactly the configured limit and rejects the next request with 429", async () => {
    const body = { email: "throttle-test@example.com", password: "whatever-not-checked" };

    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer()).post("/auth/login").send(body);
      expect(res.status).not.toBe(429);
    }

    const eleventh = await request(app.getHttpServer()).post("/auth/login").send(body);
    expect(eleventh.status).toBe(429);
  });
});
