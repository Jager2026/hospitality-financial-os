// Set by AuditLogInterceptor.catchError the moment it logs a failure, so AllExceptionsFilter
// (which sees every exception, including ones the interceptor never got a chance to see) can
// tell "already logged" apart from "never reached the interceptor at all" and avoid a duplicate
// row for the same failure. See both files' module-level comments for why two mechanisms exist.
export const AUDIT_LOG_WRITTEN_FLAG = "__auditLogWritten";
