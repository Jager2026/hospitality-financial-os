import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { PinoLogger } from "nestjs-pino";
import { Observable, tap } from "rxjs";
import { AUDIT_ENTITY_KEY } from "../decorators/audit-entity.decorator";
import { PrismaService } from "../../prisma/prisma.service";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface AuthedRequest extends Request {
  user?: { id: string };
}

// ADR-010 / SYSTEM_ARCHITECTURE.md: "a shared interceptor applied to all mutating endpoints —
// not a utility each feature must remember to call." Applied globally in main.ts. No business
// module writes to AuditLog directly yet (none exist before Sprint 3) — this is the mechanism,
// wired up automatically the moment a real mutating controller exists.
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
      tap((data) => {
        void this.write(request, entity, data);
      }),
    );
  }

  private async write(request: AuthedRequest, entity: string, data: unknown): Promise<void> {
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

  private extractId(data: unknown): string | null {
    if (data && typeof data === "object" && "id" in data && typeof data.id === "string") {
      return data.id;
    }
    return null;
  }
}
