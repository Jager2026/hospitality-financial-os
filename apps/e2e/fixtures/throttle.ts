import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** The namespace `RedisThrottlerStorage` writes under (ADR-042). Kept in one place so a change
 * there is a change here, rather than two prefixes drifting apart. */
const THROTTLE_PREFIX = "throttle:";

/**
 * Clears rate-limit state between tests.
 *
 * Real throttler, real Redis, real limits — **only the state is reset**. Raising the limit in the
 * test environment was rejected: it would weaken the exact behaviour under test, and a check that
 * has been quietly relaxed is worse than one that does not exist.
 *
 * This is possible at all only because of ADR-042. Before it, the counter lived in the backend
 * process's memory and nothing outside could touch it — which meant the whole e2e run shared a
 * single ten-per-minute budget on `/auth/*` and the limit could never be tested on its own.
 *
 * ── Why the prefix scan and not FLUSHDB ────────────────────────────────────────────────────────
 * Token revocation lives in the same Redis under `auth:` (`token.service.ts`). A blanket flush
 * would un-revoke every logged-out session and every family revoked on refresh-token reuse
 * detection — silently, and only in tests, which is where a habit of blanket flushes gets learned
 * before it is applied somewhere it matters. `redis-throttler.storage.spec.ts` asserts the
 * namespaces stay separate; this function relies on that.
 */
export async function resetRateLimits(): Promise<void> {
  const client = new Redis(REDIS_URL);
  try {
    const keys = await client.keys(`${THROTTLE_PREFIX}*`);
    if (keys.length > 0) await client.del(...keys);
  } finally {
    await client.quit();
  }
}
