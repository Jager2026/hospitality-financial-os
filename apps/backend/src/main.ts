import "reflect-metadata";
import "./common/bigint-json.polyfill";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { UnhandledErrorAlerter } from "./common/alerting/unhandled-error-alerter";

async function bootstrap(): Promise<void> {
  // rawBody: true attaches the exact, unparsed request bytes to request.rawBody on every
  // request, alongside the normal JSON-parsed request.body — needed for Stripe webhook signature
  // verification (stripe.webhooks.constructEvent), which HMACs the raw bytes as received. A
  // re-serialized JSON.stringify of the parsed body can differ from the original bytes (key
  // order, whitespace, number formatting) and would break verification. Every other route is
  // unaffected — this only adds a buffer, it doesn't change how the body is parsed.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  app.useLogger(app.get(Logger));
  // Sprint 11 (Security Hardening), OWASP A02:2025 (Security Misconfiguration): standard helmet
  // defaults (HSTS, X-Content-Type-Options, X-Frame-Options, etc.) — no custom CSP directives yet,
  // since this API serves no HTML of its own to apply a Content-Security-Policy against; revisit
  // if that changes rather than guessing directives now.
  app.use(helmet());

  // API_Contract.md, Base URL — /health stays unprefixed (infra-facing: Docker healthcheck, load
  // balancers), and so does /webhooks/stripe (a fixed integration point Stripe itself calls, not
  // a client-facing REST resource evolving under /api/v1 -> /api/v2 the way the rest of the
  // contract does — same reasoning as /health, not an oversight).
  app.setGlobalPrefix("api/v1", { exclude: ["health", "webhooks/stripe"] });

  // Sprint 11: CORS_ORIGIN replaces the previous bare enableCors() (NestJS's own default reflects
  // any Origin — the same OWASP A02:2025 class as the missing security headers above). Read via
  // ConfigService rather than process.env directly so this fails the same way every other required
  // env var already does (validateEnv, config/env.validation.ts) if it's ever missing.
  const configService = app.get(ConfigService);
  const corsOrigin = configService.getOrThrow<string[]>("CORS_ORIGIN");
  app.enableCors({ origin: corsOrigin });

  // ADR-045 — the half nothing covered.
  //
  // `AllExceptionsFilter` sees every failure inside the HTTP pipeline and nothing outside it. A
  // rejected promise in `OutboxPollerService`, `PaymentReconciliationService`, or any `@Interval`
  // job never reaches a request, so it never reached the filter either: Node terminated the
  // process, Railway restarted it under `restartPolicyType: ON_FAILURE`, and **no trace of the
  // failure survived anywhere**.
  //
  // The healthcheck cannot catch this, and the reason is worth stating: it answers again after
  // every restart. **A service crashing and restarting in a loop looks, from outside, exactly like
  // a service that is working.** That is the failure mode that does not announce itself, on a
  // system whose whole design preference is for the ones that do.
  const alerter = app.get(UnhandledErrorAlerter);
  const logger = app.get(Logger);

  process.on("unhandledRejection", (reason: unknown) => {
    const name = reason instanceof Error ? reason.name : "UnhandledRejection";
    const message = reason instanceof Error ? reason.message : String(reason);
    // Unconditional, and before the alert — ADR-038's rule: an alert that exists only when
    // ALERT_WEBHOOK_URL happens to be set is not an alert.
    logger.error({ err: reason }, "Unhandled promise rejection outside the HTTP pipeline");
    alerter.report(`${name} (unhandled rejection)`, {
      name,
      message,
      origin: "unhandledRejection",
    });
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error({ err: error }, "Uncaught exception — the process is being terminated");
    alerter.report(`${error.name} (uncaught exception)`, {
      name: error.name,
      message: error.message,
      origin: "uncaughtException",
    });
    // Deliberately still fatal. After an uncaught exception the process is in an undefined state
    // and continuing risks writing money data from it; ADR-002's Ledger is not something to
    // gamble on a half-initialised runtime. The short delay is only to give the alert a chance to
    // leave the process first — the crash is not being prevented, only reported before it lands.
    setTimeout(() => process.exit(1), 500).unref();
  });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
