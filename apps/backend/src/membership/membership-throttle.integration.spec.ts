import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { TokenService } from "../auth/token.service";
import { PrismaService } from "../prisma/prisma.service";
import { MembershipInvitationService } from "./membership-invitation.service";
import { MembershipController } from "./membership.controller";
import { MembershipService } from "./membership.service";

// Same precedent as auth/auth-throttle.integration.spec.ts, requested explicitly (founder review
// of this sprint's authorization-sensitive code): POST /memberships/invitations/accept is public
// (no JwtAuthGuard) and does a DB lookup by email plus a hash-compare per candidate — the same
// cost/risk shape as a login attempt — so it carries the same @Throttle({ limit: 10, ttl: 60_000 })
// override as AuthController (API_Contract.md, Rate Limiting: "Public low"), rather than falling
// through to the global 100/min baseline (ADR-010). Exercises the real MembershipController class
// and its real decorator through an actual HTTP request cycle, not a re-declared copy of the
// config that could silently drift from the real one.
describe("MembershipController — accept-invitation throttle (integration)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const fakeInvitationService = {
      accept: vi.fn().mockRejectedValue(new Error("not reached before the limit")),
      invite: vi.fn(),
    };
    const fakeMembershipService = {
      findAllForUser: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      disable: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      // Same global default as app.module.ts (100/min) — the point is confirming the route-level
      // override to 10/min actually takes effect, not the global fallback.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [MembershipController],
      providers: [
        { provide: MembershipInvitationService, useValue: fakeInvitationService },
        { provide: MembershipService, useValue: fakeMembershipService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        // Never exercised by this test (only the public accept route is called) — needed only
        // because MembershipController also declares JwtAuthGuard/PermissionsGuard-protected
        // routes, and Nest constructs every guard referenced anywhere in the controller at
        // compile time, regardless of which route a given test actually calls (same reasoning as
        // auth-throttle.integration.spec.ts).
        { provide: TokenService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        JwtAuthGuard,
        PermissionsGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows exactly the configured limit and rejects the next request with 429", async () => {
    const body = { email: "throttle-test@example.com", token: "whatever-not-checked" };

    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer())
        .post("/memberships/invitations/accept")
        .send(body);
      expect(res.status).not.toBe(429);
    }

    const eleventh = await request(app.getHttpServer())
      .post("/memberships/invitations/accept")
      .send(body);
    expect(eleventh.status).toBe(429);
  });
});
