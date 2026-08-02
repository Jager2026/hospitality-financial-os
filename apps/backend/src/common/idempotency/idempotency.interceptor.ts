import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { Observable, from, of } from "rxjs";
import { switchMap, tap, catchError } from "rxjs/operators";
import { AppException } from "../exceptions/app.exception";
import { PrismaService } from "../../prisma/prisma.service";
import { computeFingerprint } from "./fingerprint.util";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — API_Contract.md: "Keys expire after a fixed retention window"

// ADR-004 / API_Contract.md's Idempotency contract, implemented as an opt-in interceptor:
//   @UseInterceptors(IdempotencyInterceptor)
// on any financial endpoint (first real use: Sprint 5's POST /payments). Not applied globally —
// only financial endpoints require an Idempotency-Key at all.
//
// KNOWN ORDERING ISSUE, not yet fixed because nothing uses this interceptor yet — tracked as an
// explicit Sprint 5 Definition of Done item in IMPLEMENTATION_PLAN.md, not just this comment:
// global interceptors (AuditLogInterceptor,
// ResponseInterceptor — app.module.ts APP_INTERCEPTOR) wrap *outside* a method-level
// @UseInterceptors(IdempotencyInterceptor). That means on a replayed idempotent request (cached
// response returned, handler never re-invoked), AuditLogInterceptor's `next.handle()` still
// resolves and still writes an AuditLog row — logging a second "mutation" that didn't actually
// happen. Before wiring this into a real controller, either have this interceptor mark the
// request (e.g. a request-scoped flag AuditLogInterceptor checks) when serving a cached replay,
// or move idempotency resolution ahead of the audit interceptor in the chain.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = request.headers[IDEMPOTENCY_KEY_HEADER];

    if (!key || Array.isArray(key)) {
      throw new AppException(
        "VALIDATION_ERROR",
        "Idempotency-Key header is required for this endpoint.",
        400,
      );
    }

    const fingerprint = computeFingerprint(request.body);
    const endpointScope = request.route?.path ?? request.path;

    return from(this.prisma.idempotencyKey.findUnique({ where: { key } })).pipe(
      switchMap((existing) => {
        if (!existing) {
          return from(
            this.prisma.idempotencyKey.create({
              data: {
                key,
                endpointScope,
                requestFingerprint: fingerprint,
                status: "IN_PROGRESS",
                expiresAt: new Date(Date.now() + KEY_TTL_MS),
              },
            }),
          ).pipe(switchMap(() => this.runHandler(next, key)));
        }

        if (existing.requestFingerprint !== fingerprint) {
          throw new AppException(
            "IDEMPOTENCY_KEY_CONFLICT",
            "This Idempotency-Key was already used with a different request.",
            409,
          );
        }

        if (existing.status === "COMPLETED") {
          return of(existing.responseSnapshot);
        }

        // IN_PROGRESS (concurrent duplicate) or FAILED (prior attempt errored). Sprint 1 keeps
        // this simple: reject rather than wait-and-retry or auto-replay a failed attempt. Revisit
        // if Sprint 5 needs friendlier concurrent-retry behavior.
        throw new AppException(
          "IDEMPOTENCY_KEY_CONFLICT",
          existing.status === "IN_PROGRESS"
            ? "A request with this Idempotency-Key is already being processed."
            : "The previous request with this Idempotency-Key failed. Retry with a new key.",
          409,
        );
      }),
    );
  }

  private runHandler(next: CallHandler, key: string): Observable<unknown> {
    return next.handle().pipe(
      tap((response) => {
        void this.prisma.idempotencyKey.update({
          where: { key },
          data: { status: "COMPLETED", responseSnapshot: response },
        });
      }),
      catchError((err) => {
        void this.prisma.idempotencyKey.update({ where: { key }, data: { status: "FAILED" } });
        throw err;
      }),
    );
  }
}
