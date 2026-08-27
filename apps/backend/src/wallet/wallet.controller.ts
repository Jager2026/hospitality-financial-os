import { Controller, Get, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard, type AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { AppException } from "../common/exceptions/app.exception";
import { WalletService } from "./wallet.service";

// API_Contract.md, WALLETS.
@Controller()
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get("wallets")
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.walletService.findMine(user);
  }

  @Get("wallets/:id")
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.walletService.findOne(id, user);
  }

  @Get("wallets/:id/transactions")
  findTransactions(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.walletService.findTransactions(id, user);
  }

  /** ADR-039. Lives in WalletController, not MembershipController, following this codebase's own
   * convention: a nested route belongs to the domain it *returns*, not the one in its path prefix
   * — the same reason `GET /restaurants/:id/tips` is TipController's and `GET /restaurants/:id/staff`
   * is MembershipController's (ADR-033).
   *
   * A separate route from `GET /wallets`, not a filter on it (ADR-039 rejects that explicitly):
   * "my wallets" and "this employee's wallet" are different operations under different rules, and
   * one shared return type does not make them one endpoint. */
  @Get("memberships/:id/wallet")
  findByMembership(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.walletService.findByMembership(id, user);
  }

  // IMPLEMENTATION_PLAN.md Sprint 7: "Future Withdrawals Placeholder" — a real, documented route
  // (API_Contract.md: "POST /wallets/{id}/withdrawals — future.") that answers honestly rather
  // than 404ing as if the concept doesn't exist. Confirms the caller can actually reach this
  // specific Wallet (own wallet only — a withdrawal request is personal, never something a
  // reachable-but-not-own Membership can act on) before refusing, so the error means "not built
  // yet," never "not yours."
  @Post("wallets/:id/withdrawals")
  async requestWithdrawal(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    const wallet = await this.walletService.findOne(id, user);
    const isOwnWallet = user.memberships.some((m) => m.id === wallet.membershipId);
    if (!isOwnWallet) {
      // findOne's own reachability check already allows non-owners (e.g. a Manager) to view a
      // Wallet — withdrawal is narrower, own-wallet-only.
      throw new AppException(
        "PERMISSION_DENIED",
        "Only the Wallet's own holder can request a withdrawal.",
        403,
      );
    }
    throw new AppException(
      "WITHDRAWAL_NOT_AVAILABLE",
      "Withdrawals are not available yet.",
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}
