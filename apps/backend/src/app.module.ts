import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { validateEnv } from "./config/env.validation";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { HealthModule } from "./health/health.module";
import { LedgerModule } from "./ledger/ledger.module";
import { OutboxModule } from "./outbox/outbox.module";
import { AuthModule } from "./auth/auth.module";
import { ProfileModule } from "./profile/profile.module";
import { OrganizationModule } from "./organization/organization.module";
import { RestaurantModule } from "./restaurant/restaurant.module";
import { CurrencyModule } from "./currency/currency.module";
import { StripeModule } from "./stripe/stripe.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { AuditEntityResolverGuard } from "./common/guards/audit-entity-resolver.guard";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { AuditLogInterceptor } from "./common/interceptors/audit-log.interceptor";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
        transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
        // CLAUDE.md, Logging Philosophy: "Never log: Passwords. Secrets. Tokens. Card Numbers."
        redact: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.refreshToken",
          "req.body.card",
        ],
      },
    }),
    // ADR-010: baseline, generic rate limiting from Sprint 1 — per-endpoint tuning is Sprint 11.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    RedisModule,
    HealthModule,
    LedgerModule,
    OutboxModule,
    AuthModule,
    ProfileModule,
    StripeModule,
    OrganizationModule,
    RestaurantModule,
    CurrencyModule,
  ],
  providers: [
    // Must run before ThrottlerGuard (registration order = execution order among global guards)
    // — see AuditEntityResolverGuard's own docstring for why.
    { provide: APP_GUARD, useClass: AuditEntityResolverGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
