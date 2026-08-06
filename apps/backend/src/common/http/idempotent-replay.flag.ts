// Set by IdempotencyInterceptor synchronously, before it returns a cached responseSnapshot
// instead of invoking the real handler. AuditLogInterceptor checks this in its own tap()
// callback (which runs after the downstream chain, including IdempotencyInterceptor, has already
// resolved) to tell "the handler actually ran" apart from "this is the same mutation being
// reported a second time" — without it, a replayed idempotent request writes a second AuditLog
// row for a mutation that only happened once (IMPLEMENTATION_PLAN.md, Sprint 5 DoD). Same
// mechanism shape as AUDIT_LOG_WRITTEN_FLAG — see that file for why a request-scoped flag, not a
// return value, is how two interceptors at different levels of the same chain communicate.
export const IDEMPOTENT_REPLAY_FLAG = "__idempotentReplay";
