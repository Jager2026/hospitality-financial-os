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
/**
 * `PermissionsGuard` sits on the class, not on each method, and that is the fix for a specific
 * defect rather than a tidying preference.
 *
 * `GET /transactions/:id` carried `@RequirePermission("reports.view")` with **no guard in scope** —
 * the guard is deliberately not global (`permissions.guard.ts`), so nothing read the decorator.
 * The route was not open, because `TransactionService.findOne` performs the same check itself; what
 * was missing was the coarse pre-filter that exists to catch a service that forgets. #108 measured
 * exactly that: a zero-permission Waiter reading another restaurant's full financial breakdown.
 *
 * At class level it covers every route here, including any added later — which is the point. The
 * guard returns `true` when a route declares no permission (`getAllAndOverride` finds nothing), so
 * it costs nothing on an unguarded route, and the per-method `@UseGuards(PermissionsGuard)` lines
 * that used to sit on the two guarded routes are gone as duplicates rather than kept as belt and
 * braces: two copies of one rule is how the two drift.
 */
@Controller("transactions")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  // Registered before ":id" deliberately — same reasoning as TipController's "tips/me": Nest
  // matches routes in declaration order, and ":id" would otherwise swallow "export" by treating
  // it as an id.
  @Get("export")
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
  @RequirePermission("reports.view")
  findAll(
    @Query(new ZodValidationPipe(transactionListQuerySchema)) query: TransactionListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.transactionService.findAllForUser(user, query);
  }

  // ADR-043 gave the list and the export `reports.view`; this route had none. PR #108 measured a
  // zero-permission Waiter reading another restaurant's full transaction breakdown through it.
  @Get(":id")
  @RequirePermission("reports.view")
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.transactionService.findOne(id, user);
  }
}
