import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async updateLocale(userId: string, locale: string): Promise<{ id: string; locale: string }> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { locale },
      select: { id: true, locale: true },
    });
    return user;
  }
}
