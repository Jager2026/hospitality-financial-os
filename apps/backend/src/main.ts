import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  // API_Contract.md, Base URL — /health stays unprefixed, since it's infra-facing (Docker
  // healthcheck, load balancers), not part of the versioned client API contract.
  app.setGlobalPrefix("api/v1", { exclude: ["health"] });
  app.enableCors();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
}

void bootstrap();
