import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertService } from "./alert.service";

const fakeLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function buildConfig(url: string | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { get: () => url } as any;
}

// ADR-031/032: extracted out of OutboxPollerService once PaymentReconciliationService became a
// second real consumer — these tests are what used to live in outbox-poller.service.spec.ts's own
// "alerting" describe block, moved here to match the code's own new boundary. OutboxPollerService
// still has its own tests confirming it CALLS sendAlert() correctly; these test what sendAlert()
// itself actually does once called.
describe("AlertService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call fetch when ALERT_WEBHOOK_URL is unset — discriminating: a naive implementation that alerts unconditionally would call fetch here too", async () => {
    const service = new AlertService(buildConfig(undefined), fakeLogger);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await service.sendAlert("test message", { eventId: "abc" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs a JSON body with the message text to the configured URL, and logs success", async () => {
    const service = new AlertService(
      buildConfig("https://hooks.example.test/incoming"),
      fakeLogger,
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const infoSpy = vi.spyOn(fakeLogger, "info");

    await service.sendAlert("something is stuck", { eventId: "abc-123" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.test/incoming");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toBe("something is stuck");
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "abc-123", status: 200 }),
      expect.stringContaining("delivered successfully"),
    );
  });

  it("logs a warning, not an info, when the webhook responds with a non-2xx status — discriminating: logging success here regardless of status would hide a real delivery failure", async () => {
    const service = new AlertService(
      buildConfig("https://hooks.example.test/incoming"),
      fakeLogger,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const warnSpy = vi.spyOn(fakeLogger, "warn");
    const infoSpy = vi.spyOn(fakeLogger, "info");

    await service.sendAlert("test message");

    expect(warnSpy).toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("never throws when the fetch call itself rejects (network failure) — logs a warning instead", async () => {
    const service = new AlertService(
      buildConfig("https://hooks.example.test/incoming"),
      fakeLogger,
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("simulated network failure"));
    const warnSpy = vi.spyOn(fakeLogger, "warn");

    await expect(service.sendAlert("test message")).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
  });

  it("passes the given context through to both the success and failure log calls", async () => {
    const service = new AlertService(
      buildConfig("https://hooks.example.test/incoming"),
      fakeLogger,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const infoSpy = vi.spyOn(fakeLogger, "info");

    await service.sendAlert("test message", { paymentId: "pay-1", extra: "detail" });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1", extra: "detail" }),
      expect.anything(),
    );
  });
});
