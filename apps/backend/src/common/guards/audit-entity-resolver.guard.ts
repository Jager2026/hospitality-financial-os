import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AUDIT_ENTITY_KEY } from "../decorators/audit-entity.decorator";
import { AUDIT_ENTITY_RESOLVED_FLAG } from "../http/audit-entity-resolved.flag";

/**
 * Registered first among the global guards (app.module.ts) — before ThrottlerGuard, before any
 * route-level guard — purely to stash the route's @AuditEntity value on the request while an
 * ExecutionContext (with getHandler()/getClass()) is still available. AuditLogInterceptor can
 * resolve this metadata itself when a request reaches it, but a request a Guard rejects (throttle,
 * missing JWT) never reaches any interceptor at all — only AllExceptionsFilter sees it, and a
 * filter's ArgumentsHost has no handler/class reference to resolve @AuditEntity from. Without this,
 * AllExceptionsFilter falls back to the raw route path, which doesn't match the friendly label the
 * same route would log on success — e.g. a throttled POST /auth/login logging entity=
 * "/api/v1/auth/login" while a successful one logs entity="Authentication" for what is, from an
 * audit trail's perspective, the same kind of event.
 *
 * Always returns true — this guard only ever observes, never rejects.
 */
@Injectable()
export class AuditEntityResolverGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const entity = this.reflector.getAllAndOverride<string>(AUDIT_ENTITY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (entity) {
      const request = context.switchToHttp().getRequest<Record<string, unknown>>();
      request[AUDIT_ENTITY_RESOLVED_FLAG] = entity;
    }
    return true;
  }
}
