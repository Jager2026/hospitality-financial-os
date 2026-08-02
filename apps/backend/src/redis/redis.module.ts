import { Global, Module } from "@nestjs/common";
import { redisClientProvider, RedisService } from "./redis.service";

@Global()
@Module({
  providers: [redisClientProvider, RedisService],
  exports: [RedisService],
})
export class RedisModule {}
