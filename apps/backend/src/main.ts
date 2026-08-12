import "reflect-metadata";
import "./common/bigint-json.polyfill";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

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

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
