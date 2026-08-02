import { SetMetadata } from "@nestjs/common";

export const AUDIT_ENTITY_KEY = "auditEntity";

/** Names the entity type a mutating route touches, e.g. @AuditEntity("Restaurant"). Read by
 * AuditLogInterceptor (ADR-010). Optional — falls back to the route path if omitted, but a
 * named entity makes AuditLog.entity meaningful instead of a raw URL fragment. */
export const AuditEntity = (entity: string) => SetMetadata(AUDIT_ENTITY_KEY, entity);
