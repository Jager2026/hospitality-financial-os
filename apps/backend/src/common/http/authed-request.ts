import type { Request } from "express";

// Shared between AuditLogInterceptor and AllExceptionsFilter — both need to read the
// JwtAuthGuard-attached user (when present) off the same request shape.
export interface AuthedRequest extends Request {
  user?: { id: string };
}
