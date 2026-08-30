import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertService } from "./alert.service";
import { UnhandledErrorAlerter } from "./unhandled-error-alerter";

/**
 * ADR-045. The policy an unhandled failure is reported under, tested where it lives rather than
 * twice at each of its two callers.
 */

function fakeAlerts() {
  return { sendAlert: vi.fn().mockResolvedValue(undefined) } as unknown as AlertService & {
    sendAlert: ReturnType<typeof vi.fn>;
  };
}

function silentLogger(): PinoLogger {
  return { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger;
}

let alerts: ReturnType<typeof fakeAlerts>;
let alerter: UnhandledErrorAlerter;

beforeEach(() => {
  alerts = fakeAlerts();
  alerter = new UnhandledErrorAlerter(alerts, silentLogger());
});

describe("UnhandledErrorAlerter", () => {
  it("reports a failure once and stays quiet for the same one afterwards", () => {
    for (let i = 0; i < 50; i += 1) {
      alerter.report("TypeError at GET /api/v1/payments", { name: "TypeError" });
    }
    // The whole point: an error in a hot path must not turn one incident into a flood on the
    // alerting channel. Same "exactly once per incident" discipline as OutboxPollerService.
    expect(alerts.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("still reports a DIFFERENT failure — deduplication is per incident, not a global mute", () => {
    // The discriminating half. "Called once" alone would pass against an implementation that
    // alerts once and then never again for anything, which would be far worse than a flood.
    alerter.report("TypeError at GET /api/v1/payments", {});
    alerter.report("PrismaClientKnownRequestError at POST /api/v1/payments", {});
    expect(alerts.sendAlert).toHaveBeenCalledTimes(2);
  });

  it("never lets a failing alert become a second failure inside the error handler", async () => {
    const broken = {
      sendAlert: vi.fn().mockRejectedValue(new Error("webhook unreachable")),
    } as unknown as AlertService;
    const resilient = new UnhandledErrorAlerter(broken, silentLogger());

    // Synchronous by contract: the caller is an exception filter mid-response, and a rejected
    // promise escaping here would be caught by the very handler that produced it.
    expect(() => resilient.report("TypeError at GET /x", {})).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("carries only the safe fields — never the exception object, never the request", () => {
    // CLAUDE.md's Logging Philosophy forbids letting request bodies, tokens or card data out of
    // the process. The logger has redaction configured; a webhook POST does not. So the caller
    // chooses the safe set, and this asserts the shape that reaches the wire.
    alerter.report("TypeError at GET /api/v1/payments/:id", {
      name: "TypeError",
      message: "Cannot read properties of undefined",
      route: "GET /api/v1/payments/:id",
      status: 500,
    });

    const [, context] = alerts.sendAlert.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(context).sort()).toEqual(["message", "name", "route", "status"]);
    expect(JSON.stringify(context)).not.toContain("password");
  });
});
