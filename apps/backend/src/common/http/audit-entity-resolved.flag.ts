// Set by AuditEntityResolverGuard (runs first, before any guard that might reject the request)
// so AllExceptionsFilter — which only ever sees ArgumentsHost, not ExecutionContext, so it can't
// call getHandler()/getClass() to resolve @AuditEntity itself — can use the same entity value
// AuditLogInterceptor would have used had the request reached it. Without this, a throttled
// request and a wrong-password request on the same route logged two different `entity` values
// for what's conceptually the same failure.
export const AUDIT_ENTITY_RESOLVED_FLAG = "__auditEntityResolved";
