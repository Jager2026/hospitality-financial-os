import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own identity fields, read from the User row.
   *
   * **`displayName` is why this method exists.** `GET /profile` returned the token-derived
   * `AuthenticatedUser`, which carries id, email, locale and memberships — and no name. The
   * Dashboard has returned OTHER people's display names since ADR-033 (Top Staff), so the one
   * person who could not read their own name was the person logged in
   * (UX_API_RECONCILIATION, section B).
   *
   * Additive on purpose: the controller merges this over what it already returned, so
   * memberships and everything else a caller depends on stay exactly where they were. */
  async getIdentity(
    userId: string,
  ): Promise<{ id: string; email: string; displayName: string; locale: string }> {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, displayName: true, locale: true },
    });
  }

  async updateLocale(
    userId: string,
    locale: string,
  ): Promise<{ id: string; email: string; displayName: string; locale: string }> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { locale },
      // displayName included so PATCH answers with the same identity shape GET does — a screen
      // that re-reads the response after saving must not lose the name it was showing.
      select: { id: true, email: true, displayName: true, locale: true },
    });
    return user;
  }
}
