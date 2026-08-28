import { Controller, Get, Header, Param, Query, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../auth/decorators/require-permission.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PermissionsGuard } from "../auth/guards/permissions.guard";
import { SkipEnvelope } from "../common/decorators/skip-envelope.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  transactionExportQuerySchema,
  transactionListQuerySchema,
  type TransactionExportQueryDto,
  type TransactionListQueryDto,
} from "./dto/transaction-list-query.schema";
import { TransactionService } from "./transaction.service";

// API_Contract.md, TRANSACTIONS.
@Controller("transactions")
@UseGuards(JwtAuthGuard)
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  // Registered before ":id" deliberately — same reasoning as TipController's "tips/me": Nest
  // matches routes in declaration order, and ":id" would otherwise swallow "export" by treating
  // it as an id.
  @Get("export")
  @UseGuards(PermissionsGuard)
  @RequirePermission("data.export")
  @SkipEnvelope() // a CSV body, not API_Contract.md's {success,data,meta} JSON envelope
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="transactions.csv"')
  exportCsv(
    @Query(new ZodValidationPipe(transactionExportQuerySchema)) query: TransactionExportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.transactionService.exportCsv(user, query);
  }

  // ADR-043: was the only route of its kind without a permission decorator. The absence was an
  // OMISSION, not a design: the Dashboard, Analytics and the CSV export of this same data all
  // require a permission, and different formats of one question must not have different bars.
  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermission("reports.view")
  findAll(
    @Query(new ZodValidationPipe(transactionListQuerySchema)) query: TransactionListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.transactionService.findAllForUser(user, query);
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.transactionService.findOne(id, user);
  }
}
