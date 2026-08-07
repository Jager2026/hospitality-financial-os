import "reflect-metadata";
import "./common/bigint-json.polyfill";
import { NestFactory } from "@nestjs/core";
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
  // API_Contract.md, Base URL — /health stays unprefixed (infra-facing: Docker healthcheck, load
  // balancers), and so does /webhooks/stripe (a fixed integration point Stripe itself calls, not
  // a client-facing REST resource evolving under /api/v1 -> /api/v2 the way the rest of the
  // contract does — same reasoning as /health, not an oversight).
  app.setGlobalPrefix("api/v1", { exclude: ["health", "webhooks/stripe"] });
  app.enableCors();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
