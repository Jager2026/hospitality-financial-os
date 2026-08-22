import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import type { Env } from "../../config/env.validation";

/** ADR-031's Outbox Lag alert, generalized (ADR-032): the second real consumer
 * (PaymentReconciliationService) is what earns this its own shared home — before that, one
 * private method on OutboxPollerService was the whole mechanism, the same "a registry/abstraction
 * earns its cost once a second one lands" reasoning already applied elsewhere in this codebase
 * (Outbox's own no-handler-registry design, ADR-024).
 *
 * Vendor-neutral by design, unchanged from ADR-031: `ALERT_WEBHOOK_URL` optional, a plain JSON
 * POST works for Slack/Discord incoming webhooks out of the box, no SDK. A failed delivery is
 * logged and swallowed, never thrown — the caller's own retry/recovery logic matters more than
 * this notification succeeding. */
@Injectable()
export class AlertService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AlertService.name);
  }

  async sendAlert(message: string, context: Record<string, unknown> = {}): Promise<void> {
    const url = this.config.get("ALERT_WEBHOOK_URL", { infer: true });
    if (!url) return;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      if (!response.ok) {
        this.logger.warn(
          { ...context, status: response.status },
          "Alert webhook responded with a non-2xx status",
        );
      } else {
        this.logger.info(
          { ...context, status: response.status },
          "Alert webhook delivered successfully",
        );
      }
    } catch (err) {
      this.logger.warn(
        { ...context, err },
        "Alert webhook request itself failed — the underlying condition it was reporting is still logged separately and unaffected by this",
      );
    }
  }
}
