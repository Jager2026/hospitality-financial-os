import { Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import { PinoLogger } from "nestjs-pino";
import { AlertService } from "../alerting/alert.service";
import { RedisService } from "../../redis/redis.service";

/**
 * Shared rate-limit state, in Redis rather than in each process's memory (ADR-042).
 *
 * The default `@nestjs/throttler` storage keeps its counter in a `Map` inside the Node process.
 * `ADR-028` Decision 5 already recorded that — but as a known property, not as a defect. It is a
 * defect: with two backend instances the documented 10/min silently becomes 20/min, because each
 * instance counts only what it saw. Today that stays latent purely because Railway runs a single
 * instance, which means the correctness of a protective mechanism rests on an infrastructure fact
 * recorded in no document and guarded by nothing.
 *
 * ── Namespacing is load-bearing, not tidiness ──────────────────────────────────────────────────
 * Every key here is prefixed `throttle:`. Token revocation lives in the same Redis under `auth:`
 * (`token.service.ts`). Anything that clears throttle state — the e2e fixture does exactly this —
 * must be able to target these keys and only these keys. A `FLUSHALL` would un-revoke every
 * logged-out session and every family revoked on reuse detection, silently.
 */

const PREFIX = "throttle:";

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  /** Whether the last Redis interaction failed. Exists so the alert fires once per outage rather
   * than once per request: the webhook route alone allows 500/min (ADR-028), so alerting per
   * request would turn a Redis outage into a flood on our own alerting channel — the same
   * "exactly once per incident" discipline `OutboxPollerService` already applies. */
  private degraded = false;

  constructor(
    private readonly redis: RedisService,
    private readonly alerts: AlertService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisThrottlerStorage.name);
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const record = await this.incrementInRedis(key, ttl, limit, blockDuration, throttlerName);
      this.markHealthy();
      return record;
    } catch (error) {
      return this.failOpen(error);
    }
  }

  private async incrementInRedis(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.redis.getClient();
    const hitKey = `${PREFIX}${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    // Already blocked: report the remaining block without spending another hit, so a caller
    // hammering a blocked endpoint cannot extend their own penalty indefinitely.
    const blockTtlMs = await client.pttl(blockKey);
    if (blockTtlMs > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockTtlMs / 1000),
      };
    }

    // INCR then set the expiry only on the first hit. Doing it in that order matters: setting the
    // expiry on every hit would slide the window forward with each request, so a steady stream of
    // calls would never let the counter reset and the limit would become permanent rather than
    // per-minute.
    const totalHits = await client.incr(hitKey);
    if (totalHits === 1) {
      await client.pexpire(hitKey, ttl);
    }
    const hitTtlMs = await client.pttl(hitKey);
    const timeToExpire = Math.ceil(Math.max(hitTtlMs, 0) / 1000);

    if (totalHits > limit) {
      await client.set(blockKey, "1", "PX", blockDuration);
      return {
        totalHits,
        timeToExpire,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    return { totalHits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
  }

  /**
   * Redis is unreachable: allow the request through (ADR-042, Founder decision).
   *
   * `ThrottlerGuard` is a global guard, so failing closed would make Redis a hard dependency of
   * the entire API. The first thing to break would be Stripe's webhooks — payments would stop
   * reaching the Ledger while Stripe and Postgres were both perfectly healthy. `ADR-019` already
   * accepts losing Redis as a survivable risk for token revocation, so treating it as critical
   * here alone would be inconsistent.
   *
   * The cost is stated rather than hidden: while degraded, brute-force protection is not applied.
   * bcrypt's own cost keeps that from being free to an attacker, and the alert below is what makes
   * the window observable rather than silent.
   */
  private failOpen(error: unknown): ThrottlerStorageRecord {
    if (!this.degraded) {
      this.degraded = true;
      // Logged unconditionally, before and independently of the webhook — ADR-038's rule: an
      // alert that only exists when ALERT_WEBHOOK_URL happens to be configured is not an alert.
      this.logger.error(
        { err: error },
        "Rate limiting is DEGRADED — Redis is unreachable, requests are being allowed through unthrottled",
      );
      void this.alerts.sendAlert(
        "Rate limiting degraded: Redis unreachable. Requests are passing unthrottled until it recovers.",
        { component: RedisThrottlerStorage.name },
      );
    }
    return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
  }

  private markHealthy(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.logger.warn("Rate limiting RECOVERED — Redis is reachable again, throttling is active");
    void this.alerts.sendAlert(
      "Rate limiting recovered: Redis is reachable, throttling is active.",
      {
        component: RedisThrottlerStorage.name,
      },
    );
  }
}

export { PREFIX as THROTTLE_KEY_PREFIX };
