import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

export const redisClientProvider = {
  provide: REDIS_CLIENT,
  useFactory: (config: ConfigService) => new Redis(config.getOrThrow<string>("REDIS_URL")),
  inject: [ConfigService],
};

@Injectable()
export class RedisService implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  getClient(): Redis {
    return this.client;
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === "PONG";
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
