import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertService } from "../common/alerting/alert.service";
import type { Env } from "../config/env.validation";
import { StripeService } from "./stripe.service";

// The SDK's network boundary is faked here, the same boundary every other test in this codebase
// fakes — no test anywhere makes a live Stripe call.
const stripeMocks = vi.hoisted(() => ({ accountsList: vi.fn() }));

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: { create: vi.fn(), retrieve: vi.fn() },
    v2: {
      core: { accounts: { create: vi.fn(), retrieve: vi.fn(), list: stripeMocks.accountsList } },
    },
    accountLinks: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  })),
}));

// ADR-038 Decision 2. This covers the mechanism that catches the corruption shape validation
// cannot see — a credential that looks perfectly well-formed and simply does not work.
describe("StripeService — boot-time credential probe (ADR-038)", () => {
  let alerts: { sendAlert: ReturnType<typeof vi.fn> };
  let logger: {
    setContext: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };

  function build(nodeEnv: string) {
    const config = {
      getOrThrow: (key: string) => {
        if (key === "STRIPE_SECRET_KEY") return "sk_test_fake_never_really_called";
        if (key === "STRIPE_WEBHOOK_SECRET") return "whsec_fake_never_really_called";
        if (key === "NODE_ENV") return nodeEnv;
        throw new Error(`unexpected config key: ${key}`);
      },
    } as unknown as ConfigService<Env, true>;
    return new StripeService(
      config,
      alerts as unknown as AlertService,
      logger as unknown as PinoLogger,
    );
  }

  beforeEach(() => {
    stripeMocks.accountsList.mockReset();
    alerts = { sendAlert: vi.fn().mockResolvedValue(undefined) };
    logger = { setContext: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  });

  it("rejects the real one-character-truncation incident: the probe fails, an ERROR is logged and an alert is dispatched", async () => {
    // The exact error Stripe returned for the truncated key, for eleven days.
    const realError = Object.assign(
      new Error(
        "You provided a malformed API Key, ensure you provided the full key in the Authorization header.",
      ),
      { code: "invalid_v2_key", rawType: "invalid_request_error", statusCode: 401 },
    );
    stripeMocks.accountsList.mockRejectedValueOnce(realError);

    await build("production").onModuleInit();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatch(/STRIPE CREDENTIAL REJECTED AT BOOT/);
    expect(alerts.sendAlert).toHaveBeenCalledTimes(1);
    expect(alerts.sendAlert.mock.calls[0][0]).toMatch(/invalid_v2_key/);
  });

  it("logs the ERROR even when the alert channel is unconfigured — the log must not depend on ALERT_WEBHOOK_URL", async () => {
    // AlertService returns early (no throw, no delivery) when ALERT_WEBHOOK_URL is unset — ADR-031
    // makes it optional. A naive implementation that only called sendAlert() would be silent in
    // exactly the deployment that has no webhook configured. This asserts the split.
    stripeMocks.accountsList.mockRejectedValueOnce(new Error("nope"));
    alerts.sendAlert.mockResolvedValue(undefined); // the unconfigured no-op path

    await build("production").onModuleInit();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatch(/STRIPE CREDENTIAL REJECTED AT BOOT/);
  });

  it("never blocks boot — a failing probe resolves rather than throwing (Founder decision: solve time-to-discovery, not deny availability)", async () => {
    stripeMocks.accountsList.mockRejectedValueOnce(new Error("stripe is down"));
    await expect(build("production").onModuleInit()).resolves.toBeUndefined();
  });

  it("survives a throwing AlertService — a broken notifier must not turn a diagnostic into a crashed boot", async () => {
    stripeMocks.accountsList.mockRejectedValueOnce(new Error("nope"));
    alerts.sendAlert.mockRejectedValueOnce(new Error("alert channel exploded"));

    await expect(build("production").onModuleInit()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("stays silent on a healthy credential", async () => {
    stripeMocks.accountsList.mockResolvedValueOnce({ data: [] });
    await build("production").onModuleInit();

    expect(logger.error).not.toHaveBeenCalled();
    expect(alerts.sendAlert).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  // Discriminating on the gating itself: an implementation that probed unconditionally would make
  // a live third-party call from CI and from every developer's machine, against placeholder keys —
  // breaking this codebase's own "no test makes a live network call" precedent and producing
  // permanent false alarms that train everyone to ignore the real one.
  it("does not probe outside production — no Stripe call at all in development or test", async () => {
    await build("development").onModuleInit();
    await build("test").onModuleInit();

    expect(stripeMocks.accountsList).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(alerts.sendAlert).not.toHaveBeenCalled();
  });
});
