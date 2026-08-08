import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { PinoLogger } from "nestjs-pino";
import { Observable, catchError, from, map, of, switchMap, throwError } from "rxjs";
import { AUDIT_ENTITY_KEY } from "../decorators/audit-entity.decorator";
import { AppException } from "../exceptions/app.exception";
import { AUDIT_LOG_WRITTEN_FLAG } from "../http/audit-log-written.flag";
import { IDEMPOTENT_REPLAY_FLAG } from "../http/idempotent-replay.flag";
import type { AuthedRequest } from "../http/authed-request";
import { MUTATING_METHODS } from "../http/mutating-methods";
import { PrismaService } from "../../prisma/prisma.service";

// ADR-010 / SYSTEM_ARCHITECTURE.md: "a shared interceptor applied to all mutating endpoints —
// not a utility each feature must remember to call." Applied globally in main.ts.
//
// Covers both channels: `switchMap` for a successful mutation, `catchError` for one that fails
// after reaching this far — thrown from a Pipe or from inside the handler/service itself. A failure
// thrown by a Guard (JwtAuthGuard, PermissionsGuard, ThrottlerGuard) never reaches either
// operator: NestJS runs Guards before Interceptors, so a Guard rejection short-circuits before
// `intercept()` is ever called (confirmed against this codebase's own PermissionsGuard comment
// on the same ordering fact). AllExceptionsFilter is the fallback for exactly that case, and
// checks AUDIT_LOG_WRITTEN_FLAG below to avoid double-logging a failure this interceptor already
// recorded.
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditLogInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }

    const entity =
      this.reflector.getAllAndOverride<string>(AUDIT_ENTITY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ??
      request.route?.path ??
      request.path;

    return next.handle().pipe(
      // AWAITS the write (switchMap, not a fire-and-forget `tap`/`void`) — found via a real CI
      // failure (not a hypothetical): under load, the HTTP response could reach the client before
      // this write landed, so a test asserting on the row immediately after `await request(...)`
      // could observe zero rows. Same class of bug, same fix, as IdempotencyInterceptor's own
      // runHandler() — see that class's doc comment.
      switchMap((data) => {
        // IdempotencyInterceptor (route-level, wraps INSIDE this one) sets this flag before
        // emitting a cached response instead of re-invoking the handler — the mutation this row
        // would describe already happened, and was already logged, on the original request.
        if ((request as unknown as Record<string, unknown>)[IDEMPOTENT_REPLAY_FLAG]) {
          return of(data);
        }
        return from(this.writeSuccess(request, entity, data)).pipe(map(() => data));
      }),
      catchError((err: unknown) => {
        // Set synchronously, before the write below, so it's visible to AllExceptionsFilter —
        // which runs only once this observable actually errors, i.e. after the write below has
        // already been awaited — regardless of whether it's reading the flag "in time".
        (request as unknown as Record<string, unknown>)[AUDIT_LOG_WRITTEN_FLAG] = true;
        return from(this.writeFailure(request, entity, err)).pipe(
          switchMap(() => throwError(() => err)),
        );
      }),
    );
  }

  private async writeSuccess(request: AuthedRequest, entity: string, data: unknown): Promise<void> {
    const entityId = this.extractId(data);
    if (!entityId) {
      // No id on the response — nothing to attach this event to yet. Visible in logs during
      // development rather than silently skipped, so a new controller doesn't go un-audited
      // by accident.
      this.logger.warn({ entity, path: request.path }, "AuditLog skipped: no id in response");
      return;
    }

    await this.prisma.auditLog.create({
      data: {
        userId: request.user?.id ?? null,
        entity,
        entityId,
        action: request.method.toLowerCase(),
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
  }

  /** No response body to pull an id from on a failure, so there's no real target record — the
   * entityId is the id of this failure event itself (the acting user's id when known, e.g. a
   * permission check failing after auth succeeded; otherwise a fresh id, e.g. a failed login
   * where no session exists yet). Never includes the request body: CLAUDE_RULES.md, Logging
   * Philosophy — passwords must never be logged, and a generic failure handler that doesn't know
   * per-route DTO shapes has no safe way to redact one field from an arbitrary body anyway. */
  private async writeFailure(request: AuthedRequest, entity: string, err: unknown): Promise<void> {
    const { code, statusCode } = this.describeError(err);
    await this.prisma.auditLog.create({
      data: {
        userId: request.user?.id ?? null,
        entity,
        entityId: request.user?.id ?? randomUUID(),
        action: `${request.method.toLowerCase()}_failed`,
        metadata: { statusCode, code },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
  }

  private describeError(err: unknown): { code: string | null; statusCode: number | null } {
    const statusCode = err instanceof HttpException ? err.getStatus() : null;
    const code = err instanceof AppException ? err.code : null;
    return { code, statusCode };
  }

  private extractId(data: unknown): string | null {
    if (data && typeof data === "object" && "id" in data && typeof data.id === "string") {
      return data.id;
    }
    return null;
  }
}
