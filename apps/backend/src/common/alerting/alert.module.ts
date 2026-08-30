import { Module } from "@nestjs/common";
import { AlertService } from "./alert.service";
import { UnhandledErrorAlerter } from "./unhandled-error-alerter";

@Module({
  providers: [AlertService, UnhandledErrorAlerter],
  exports: [AlertService, UnhandledErrorAlerter],
})
export class AlertModule {}
