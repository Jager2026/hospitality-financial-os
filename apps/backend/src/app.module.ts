import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { LoggerModule, PinoLogger } from "nestjs-pino";
import { AlertModule } from "./common/alerting/alert.module";
import { AlertService } from "./common/alerting/alert.service";
import { RedisThrottlerStorage } from "./common/throttler/redis-throttler.storage";
import { RedisService } from "./redis/redis.service";
import { validateEnv } from "./config/env.validation";
import { PrismaModule } from "./prisma/prisma.module";
import { RedisModule } from "./redis/redis.module";
import { RoleModule } from "./role/role.module";
import { HealthModule } from "./health/health.module";
import { LedgerModule } from "./ledger/ledger.module";
import { OutboxModule } from "./outbox/outbox.module";
import { AuthModule } from "./auth/auth.module";
import { ProfileModule } from "./profile/profile.module";
import { OrganizationModule } from "./organization/organization.module";
import { RestaurantModule } from "./restaurant/restaurant.module";
import { CurrencyModule } from "./currency/currency.module";
import { StripeModule } from "./stripe/stripe.module";
import { MembershipModule } from "./membership/membership.module";
import { PaymentModule } from "./payment/payment.module";
import { SettingsModule } from "./settings/settings.module";
import { TipModule } from "./tip/tip.module";
import { TransactionModule } from "./transaction/transaction.module";
import { WalletModule } from "./wallet/wallet.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { PaymentReconciliationModule } from "./payment-reconciliation/payment-reconciliation.module";
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
    // ADR-042: state moved to Redis. The default storage counts in each process's own memory, so
    // the documented limits silently multiply by the number of running instances — a defect in a
    // protective mechanism, latent today only because Railway runs one instance.
    ThrottlerModule.forRootAsync({
      imports: [AlertModule],
      inject: [RedisService, AlertService, PinoLogger],
      useFactory: (redis: RedisService, alerts: AlertService, logger: PinoLogger) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new RedisThrottlerStorage(redis, alerts, logger),
      }),
    }),
    PrismaModule,
    RedisModule,
    // ADR-045: imported at the top level, not only inside ThrottlerModule.forRootAsync — the
    // APP_FILTER below now depends on UnhandledErrorAlerter, and a provider that is only visible
    // inside another module factory typechecks fine and fails at boot. Found by starting the real
    // app, exactly as CLAUDE.md Architecture Review paragraph says this class is always found.
    AlertModule,
    HealthModule,
    LedgerModule,
    OutboxModule,
    AuthModule,
    RoleModule,
    ProfileModule,
    StripeModule,
    OrganizationModule,
    RestaurantModule,
    CurrencyModule,
    MembershipModule,
    PaymentModule,
    TipModule,
    SettingsModule,
    WalletModule,
    TransactionModule,
    DashboardModule,
    AnalyticsModule,
    WebhooksModule,
    PaymentReconciliationModule,
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
