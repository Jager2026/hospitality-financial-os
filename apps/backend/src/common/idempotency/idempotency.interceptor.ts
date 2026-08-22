import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Request } from "express";
import { Observable, from, of, throwError } from "rxjs";
import { switchMap, map, catchError } from "rxjs/operators";
import { AppException } from "../exceptions/app.exception";
import { IDEMPOTENT_REPLAY_FLAG } from "../http/idempotent-replay.flag";
import { PrismaService } from "../../prisma/prisma.service";
import { computeFingerprint } from "./fingerprint.util";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — API_Contract.md: "Keys expire after a fixed retention window"

// ADR-004 / API_Contract.md's Idempotency contract, implemented as an opt-in interceptor:
//   @UseInterceptors(IdempotencyInterceptor)
// on any financial endpoint (first real use: Sprint 5's POST /payments). Not applied globally —
// only financial endpoints require an Idempotency-Key at all.
//
// ORDERING FIX (Sprint 5 DoD: "A replayed idempotent request produces exactly one AuditLog row,
// not two"): global interceptors (AuditLogInterceptor, ResponseInterceptor — app.module.ts
// APP_INTERCEPTOR) wrap *outside* this method-level interceptor, so AuditLogInterceptor's own
// tap() still runs on a replayed response. The COMPLETED branch below sets
// IDEMPOTENT_REPLAY_FLAG on the request, synchronously, before emitting the cached response —
// AuditLogInterceptor checks that flag in its own tap() and skips writing when it's set. See
// idempotent-replay.flag.ts for why this is a request-scoped flag rather than a return value.
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
          ).pipe(
            // THREAT_MODEL.md: the real race this whole method's own findUnique-then-create shape
            // leaves open — two requests can both pass the `!existing` check above before either
            // create() lands. Only ONE create() can actually succeed (the DB's own unique
            // constraint on `key` guarantees that); this catchError closes the race architecturally
            // by mapping the LOSER's constraint violation to the same controlled 409 the
            // IN_PROGRESS branch below already returns for a slower duplicate — not a raw,
            // unhandled 500. Same shape as WebhooksService.claimEvent()'s own
            // find-then-create-then-catch pattern for the identical problem, just precise about
            // which error it catches (P2002 specifically) rather than a catch-all, since this path
            // guards a financial endpoint.
            catchError((err: unknown) => {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                return throwError(
                  () =>
                    new AppException(
                      "IDEMPOTENCY_KEY_CONFLICT",
                      "A request with this Idempotency-Key is already being processed.",
                      409,
                    ),
                );
              }
              return throwError(() => err);
            }),
            switchMap(() => this.runHandler(next, key)),
          );
        }

        if (existing.requestFingerprint !== fingerprint) {
          throw new AppException(
            "IDEMPOTENCY_KEY_CONFLICT",
            "This Idempotency-Key was already used with a different request.",
            409,
          );
        }

        if (existing.status === "COMPLETED") {
          (request as unknown as Record<string, unknown>)[IDEMPOTENT_REPLAY_FLAG] = true;
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

  /** Both branches AWAIT the status update before the response/error continues up the chain
   * (switchMap, not a fire-and-forget `tap`/`void`) — a fast legitimate retry arriving right
   * after this request finishes must see the final COMPLETED/FAILED status, not a stale
   * IN_PROGRESS row that makes it wrongly hit the concurrent-duplicate 409 branch above. */
  private runHandler(next: CallHandler, key: string): Observable<unknown> {
    return next.handle().pipe(
      switchMap((response) =>
        from(
          this.prisma.idempotencyKey.update({
            where: { key },
            data: { status: "COMPLETED", responseSnapshot: response },
          }),
        ).pipe(map(() => response)),
      ),
      catchError((err: unknown) =>
        from(
          this.prisma.idempotencyKey.update({ where: { key }, data: { status: "FAILED" } }),
        ).pipe(switchMap(() => throwError(() => err))),
      ),
    );
  }
}
