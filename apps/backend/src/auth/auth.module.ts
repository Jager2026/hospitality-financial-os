import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { PermissionsGuard } from "./guards/permissions.guard";
import { TokenService } from "./token.service";

@Module({
  imports: [JwtModule.register({})], // no default secret/expiry — TokenService always passes them explicitly per call
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtAuthGuard, PermissionsGuard],
  exports: [TokenService, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
