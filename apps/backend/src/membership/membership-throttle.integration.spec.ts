import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { TokenService } from "../auth/token.service";
import { PrismaService } from "../prisma/prisma.service";
import { MembershipInvitationService } from "./membership-invitation.service";
import { MembershipController } from "./membership.controller";
import { MembershipService } from "./membership.service";
import { syntheticCaller } from "../../test/fixtures/authenticated-user";

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

// Sprint 11 (ADR-028): same precedent as the accept-invitation block above, for the invite-
// creation route's own override — 20/min then, 5/min since ADR-070, when the thing the limit
// protects changed from rows in our own table to mail leaving a verified domain. This route IS behind JwtAuthGuard + PermissionsGuard
// (unlike accept), so both guards run for real against a fake, injected AuthenticatedUser rather
// than being faked out entirely — proves the real @RequirePermission("membership.invite") check
// and the real @Throttle decorator compose correctly, not just that the decorator exists in
// isolation.
describe("MembershipController — invite throttle (integration)", () => {
  let app: INestApplication;
  const organizationId = randomUUID();

  beforeAll(async () => {
    const fakeInvitationService = {
      invite: vi.fn().mockResolvedValue({ id: randomUUID(), email: "x@example.com", token: "t" }),
      accept: vi.fn(),
    };
    const fakeMembershipService = {
      findAllForUser: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      disable: vi.fn(),
    };
    const fakeAuthGuard: CanActivate = {
      canActivate: (context: ExecutionContext) => {
        const req = context.switchToHttp().getRequest();
        // Synthetic on purpose: this test is about the rate limiter, and the identity exists
        // only to clear the permission gate. It previously wore the name "Owner" while holding
        // one of that Role's ten Permissions — a claim the test never needed and could not honour.
        req.user = syntheticCaller({
          permissions: ["membership.invite"],
          organizationId,
          restaurantId: null,
          email: "inviter@example.com",
        });
        return true;
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [MembershipController],
      providers: [
        { provide: MembershipInvitationService, useValue: fakeInvitationService },
        { provide: MembershipService, useValue: fakeMembershipService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: TokenService, useValue: {} },
        { provide: PrismaService, useValue: {} },
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

  // ADR-070, Founder decision: 5/min, down from 20. The number is asserted here rather than only
  // declared on the decorator, because a rate limit nobody exercises is a comment.
  it("allows exactly 5/min and rejects the 6th with 429", async () => {
    const roleId = randomUUID();

    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post("/memberships")
        .send({ email: `staff-${i}@example.com`, roleId });
      expect(res.status).not.toBe(429);
    }

    const sixth = await request(app.getHttpServer())
      .post("/memberships")
      .send({ email: "staff-6@example.com", roleId });
    expect(sixth.status).toBe(429);
  });
});
