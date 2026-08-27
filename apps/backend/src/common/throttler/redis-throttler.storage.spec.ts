import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertService } from "../alerting/alert.service";
import type { RedisService } from "../../redis/redis.service";
import { RedisThrottlerStorage, THROTTLE_KEY_PREFIX } from "./redis-throttler.storage";

/**
 * ADR-042. Real Redis, not a fake — the whole point of the change is that state lives outside the
 * process, and a test against an in-memory double would pass equally well against the very
 * implementation being replaced.
 */

const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const realRedis = { getClient: () => client } as unknown as RedisService;

function silentLogger(): PinoLogger {
  return {
    setContext: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  } as unknown as PinoLogger;
}

function fakeAlerts(): AlertService & { sendAlert: ReturnType<typeof vi.fn> } {
  return { sendAlert: vi.fn().mockResolvedValue(undefined) } as unknown as AlertService & {
    sendAlert: ReturnType<typeof vi.fn>;
  };
}

let alerts: ReturnType<typeof fakeAlerts>;
let logger: PinoLogger;
let storage: RedisThrottlerStorage;
let key: string;

beforeEach(() => {
  alerts = fakeAlerts();
  logger = silentLogger();
  storage = new RedisThrottlerStorage(realRedis, alerts, logger);
  key = `spec-${randomUUID()}`;
});

afterAll(async () => {
  await client.quit();
});

describe("RedisThrottlerStorage", () => {
  it("counts across separate instances — the defect ADR-042 exists to fix", async () => {
    // THE discriminating test. Two storage objects stand in for two backend instances behind one
    // load balancer. Against the default in-memory storage each would start its own count, so a
    // limit of 3 would really be 6 — and a single-instance test would never notice, which is
    // exactly why ADR-028 recorded the behaviour as a property rather than a bug.
    const instanceA = new RedisThrottlerStorage(realRedis, alerts, logger);
    const instanceB = new RedisThrottlerStorage(realRedis, alerts, logger);

    const a1 = await instanceA.increment(key, 60_000, 3, 60_000, "default");
    const b1 = await instanceB.increment(key, 60_000, 3, 60_000, "default");
    const a2 = await instanceA.increment(key, 60_000, 3, 60_000, "default");
    const b2 = await instanceB.increment(key, 60_000, 3, 60_000, "default");

    expect([a1.totalHits, b1.totalHits, a2.totalHits]).toEqual([1, 2, 3]);
    // The fourth request is over the limit no matter which instance served it.
    expect(b2.totalHits).toBe(4);
    expect(b2.isBlocked).toBe(true);
  });

  it("blocks once the limit is exceeded and reports how long the block lasts", async () => {
    for (let i = 0; i < 2; i += 1) {
      const allowed = await storage.increment(key, 60_000, 2, 30_000, "default");
      expect(allowed.isBlocked).toBe(false);
    }
    const blocked = await storage.increment(key, 60_000, 2, 30_000, "default");
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.timeToBlockExpire).toBeGreaterThan(0);
    expect(blocked.timeToBlockExpire).toBeLessThanOrEqual(30);
  });

  it("does not slide the window — a steady stream cannot make the limit permanent", async () => {
    // Setting the expiry on every hit instead of only the first is the natural-looking mistake,
    // and it turns a per-minute limit into a permanent one for anyone who keeps calling. Asserted
    // by watching the remaining TTL shrink rather than reset.
    const first = await storage.increment(key, 5_000, 10, 5_000, "default");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await storage.increment(key, 5_000, 10, 5_000, "default");

    const firstTtl = await client.pttl(`${THROTTLE_KEY_PREFIX}default:${key}`);
    expect(second.totalHits).toBe(first.totalHits + 1);
    expect(firstTtl).toBeLessThan(5_000);
  });

  it("namespaces its keys so clearing throttle state cannot touch token revocation", async () => {
    // Load-bearing: the e2e harness clears throttle state between tests. A FLUSHALL, or a shared
    // prefix, would silently un-revoke every logged-out session and every family revoked on
    // refresh-token reuse detection (token.service.ts writes under `auth:`).
    const revocationKey = `auth:revoked-jti:${randomUUID()}`;
    await client.set(revocationKey, "1", "EX", 60);

    await storage.increment(key, 60_000, 10, 60_000, "default");
    const throttleKeys = await client.keys(`${THROTTLE_KEY_PREFIX}*`);
    expect(throttleKeys.length).toBeGreaterThan(0);
    expect(throttleKeys.every((k) => k.startsWith("throttle:"))).toBe(true);
    expect(throttleKeys).not.toContain(revocationKey);

    // Deleting every throttle key — what the fixture does — leaves revocation intact.
    await client.del(...throttleKeys);
    expect(await client.get(revocationKey)).toBe("1");
    await client.del(revocationKey);
  });
});

describe("RedisThrottlerStorage — Redis unreachable (ADR-042: fail open, loudly)", () => {
  function brokenRedis(): RedisService {
    const failing = {
      pttl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      incr: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      pexpire: vi.fn(),
      set: vi.fn(),
    };
    return { getClient: () => failing } as unknown as RedisService;
  }

  it("lets the request through rather than making Redis a hard dependency of the whole API", async () => {
    const broken = new RedisThrottlerStorage(brokenRedis(), alerts, logger);
    const record = await broken.increment(key, 60_000, 1, 60_000, "default");
    // Failing closed would break Stripe's webhooks first — payments would stop reaching the
    // Ledger with Stripe and Postgres both healthy (ADR-042).
    expect(record.isBlocked).toBe(false);
  });

  it("alerts once per outage, not once per request", async () => {
    // The webhook route alone allows 500/min (ADR-028). Alerting per request would turn a Redis
    // outage into a flood on our own alerting channel — the same "exactly once per incident"
    // discipline OutboxPollerService already applies.
    const broken = new RedisThrottlerStorage(brokenRedis(), alerts, logger);
    for (let i = 0; i < 5; i += 1) {
      await broken.increment(key, 60_000, 1, 60_000, "default");
    }
    expect(alerts.sendAlert).toHaveBeenCalledTimes(1);
    // ADR-038's rule: the ERROR log is unconditional, never contingent on a webhook being
    // configured. An alert that only exists when ALERT_WEBHOOK_URL happens to be set is not one.
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("announces recovery, so a degraded window has a visible end and not only a beginning", async () => {
    const flaky = {
      calls: 0,
      pttl: vi.fn().mockImplementation(function (this: void) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }),
      incr: vi.fn(),
      pexpire: vi.fn(),
      set: vi.fn(),
    };
    const service = { getClient: () => flaky } as unknown as RedisService;
    const storageUnderTest = new RedisThrottlerStorage(service, alerts, logger);

    await storageUnderTest.increment(key, 60_000, 10, 60_000, "default");
    expect(alerts.sendAlert).toHaveBeenCalledTimes(1);

    // Redis comes back.
    flaky.pttl.mockResolvedValue(-2);
    flaky.incr.mockResolvedValue(1);
    flaky.pexpire.mockResolvedValue(1);
    await storageUnderTest.increment(key, 60_000, 10, 60_000, "default");

    expect(alerts.sendAlert).toHaveBeenCalledTimes(2);
    expect(String(alerts.sendAlert.mock.calls[1][0])).toContain("recovered");
  });
});
