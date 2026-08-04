import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { PinoLogger } from "nestjs-pino";
import { AppException, ErrorCode } from "../exceptions/app.exception";
import { AUDIT_ENTITY_RESOLVED_FLAG } from "../http/audit-entity-resolved.flag";
import { AUDIT_LOG_WRITTEN_FLAG } from "../http/audit-log-written.flag";
import type { AuthedRequest } from "../http/authed-request";
import { MUTATING_METHODS } from "../http/mutating-methods";
import { PrismaService } from "../../prisma/prisma.service";

interface ErrorBody {
  success: false;
  error: { code: ErrorCode; message: string };
}

// API_Contract.md, Standard Response:
//   { "success": false, "error": { "code": "PAYMENT_FAILED", "message": "..." } }
// Users receive friendly messages; developers receive full diagnostics via the logger, never in
// the response body (CLAUDE.md, Error Philosophy — "never expose internal implementation").
//
// Also the AuditLog fallback for a mutating request rejected by a Guard (JwtAuthGuard,
// PermissionsGuard, ThrottlerGuard): NestJS runs Guards before Interceptors, so
// AuditLogInterceptor's `intercept()` is never even called for those — this filter is the only
// place in the pipeline that sees every exception regardless of where it was thrown. Checks
// AUDIT_LOG_WRITTEN_FLAG to skip a failure the interceptor already logged, so a request that
// fails inside the handler (which the interceptor DOES see) doesn't get double-counted here too.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<AuthedRequest>();

    if (exception instanceof AppException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as { code: ErrorCode; message: string };
      void this.auditGuardRejection(request, status, exception.code);
      response.status(status).json({ success: false, error: body } satisfies ErrorBody);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = this.extractMessage(exception);
      void this.auditGuardRejection(request, status, null);
      response.status(status).json({
        success: false,
        error: { code: this.codeForStatus(status), message },
      } satisfies ErrorBody);
      return;
    }

    // Unknown/unhandled — full detail goes to the logger only, never to the client. Not written
    // to AuditLog: this is an application defect, not a business/security event (CLAUDE.md,
    // Logging Philosophy — "Log business events. Not noise"), and the full trace is already
    // captured below for developers.
    this.logger.error({ err: exception }, "Unhandled exception");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." },
    } satisfies ErrorBody);
  }

  private async auditGuardRejection(
    request: AuthedRequest,
    statusCode: number,
    code: ErrorCode | null,
  ): Promise<void> {
    if (!MUTATING_METHODS.has(request.method)) return;
    if ((request as unknown as Record<string, unknown>)[AUDIT_LOG_WRITTEN_FLAG]) return;

    // AuditEntityResolverGuard (registered first, before ThrottlerGuard/JwtAuthGuard) stashes the
    // route's @AuditEntity value here while an ExecutionContext was still available — this filter
    // only ever gets ArgumentsHost, which can't resolve it directly. Falls back to the raw route
    // path only for a route with no @AuditEntity decorator at all.
    const resolvedEntity = (request as unknown as Record<string, unknown>)[
      AUDIT_ENTITY_RESOLVED_FLAG
    ] as string | undefined;

    await this.prisma.auditLog.create({
      data: {
        userId: request.user?.id ?? null,
        entity: resolvedEntity ?? request.route?.path ?? request.path,
        entityId: request.user?.id ?? randomUUID(),
        action: `${request.method.toLowerCase()}_failed`,
        metadata: { statusCode, code },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    });
  }

  private extractMessage(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === "string") return response;
    if (typeof response === "object" && response !== null && "message" in response) {
      const msg = (response as { message: unknown }).message;
      return Array.isArray(msg) ? msg.join(", ") : String(msg);
    }
    return exception.message;
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return "VALIDATION_ERROR";
      case HttpStatus.UNAUTHORIZED:
        return "AUTH_INVALID";
      case HttpStatus.FORBIDDEN:
        return "PERMISSION_DENIED";
      case HttpStatus.NOT_FOUND:
        return "NOT_FOUND";
      case HttpStatus.CONFLICT:
        return "IDEMPOTENCY_KEY_CONFLICT";
      default:
        return "UNKNOWN_ERROR";
    }
  }
}
