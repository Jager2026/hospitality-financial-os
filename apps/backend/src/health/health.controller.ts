import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import { SkipEnvelope } from "../common/decorators/skip-envelope.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

interface HealthCheckResult {
  status: "ok" | "degraded";
  checks: {
    database: "ok" | "down";
    redis: "ok" | "down";
  };
}

// Infra-facing (Docker healthcheck, load balancers), not part of API_Contract.md's client
// envelope or error contract — response is written directly rather than thrown through
// AllExceptionsFilter, which expects {code, message} bodies and would otherwise discard the
// {status, checks} breakdown a "degraded" result needs to actually communicate anything useful.
@Controller("health")
@SkipEnvelope()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check(@Res() res: Response): Promise<void> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);

    const result: HealthCheckResult = {
      status: database === "ok" && redis === "ok" ? "ok" : "degraded",
      checks: { database, redis },
    };

    const status = result.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(status).json(result);
  }

  private async checkDatabase(): Promise<"ok" | "down"> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return "ok";
    } catch {
      return "down";
    }
  }

  private async checkRedis(): Promise<"ok" | "down"> {
    try {
      return (await this.redis.ping()) ? "ok" : "down";
    } catch {
      return "down";
    }
  }
}
