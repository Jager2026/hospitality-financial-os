// Shared between AuditLogInterceptor (success path) and AllExceptionsFilter (failure path) so
// both agree on exactly which methods count as a mutation, without duplicating the literal set.
export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
