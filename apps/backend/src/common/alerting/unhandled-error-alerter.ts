import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { AlertService } from "./alert.service";

/**
 * One place that decides what an unhandled failure is allowed to say, and how often.
 *
 * Shared by `AllExceptionsFilter` (failures inside the HTTP pipeline) and the process-level
 * handlers in `main.ts` (failures outside it). Two callers, one policy — because the policy is
 * the part that is easy to get wrong twice.
 */

/** How long the same failure stays quiet after it has been reported once. */
const COOLDOWN_MS = 15 * 60 * 1000;

/** Bounded so a stream of distinct failures cannot grow this map without limit — the thing being
 * defended against is a broken deploy producing thousands of unique routes, and a leak inside the
 * error handler would be a poor way to discover it. */
const MAX_TRACKED = 500;

@Injectable()
export class UnhandledErrorAlerter {
  private readonly lastAlertedAt = new Map<string, number>();

  constructor(
    private readonly alerts: AlertService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UnhandledErrorAlerter.name);
  }

  /**
   * @param signature what makes two failures "the same incident" — an error name plus where it
   *   happened. Deliberately not the message: messages often carry ids, which would make every
   *   occurrence unique and defeat the deduplication entirely.
   * @param context only what is safe to send. See the note below.
   */
  report(signature: string, context: Record<string, unknown>): void {
    if (!this.shouldAlert(signature)) return;

    void this.alerts.sendAlert(`Unhandled error: ${signature}`, context).catch((error: unknown) => {
      // The alert failing must never become a second unhandled error inside the error handler.
      this.logger.warn({ err: error }, "Failed to deliver an unhandled-error alert");
    });
  }

  /**
   * Once per signature per cooldown window.
   *
   * State is in memory, per process — and unlike the rate limiter (ADR-042) that is the right
   * choice here, for a reason worth stating rather than assuming the earlier lesson transfers.
   * A rate limiter's **correctness is the count**: split it across two instances and the
   * documented limit silently doubles. Alert deduplication has no such property; its job is flood
   * prevention. With N instances a given incident produces at most N alerts instead of one —
   * bounded, obvious in the channel, and nothing like the thousands per minute this exists to
   * stop. Paying for Redis on the error path, which must work when things are already broken,
   * would buy the wrong kind of correctness.
   */
  private shouldAlert(signature: string): boolean {
    const now = Date.now();
    const last = this.lastAlertedAt.get(signature);
    if (last !== undefined && now - last < COOLDOWN_MS) return false;

    if (this.lastAlertedAt.size >= MAX_TRACKED) this.lastAlertedAt.clear();
    this.lastAlertedAt.set(signature, now);
    return true;
  }
}
