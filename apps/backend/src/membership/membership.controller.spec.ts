import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { MembershipController } from "./membership.controller";
import type { MembershipInvitationService } from "./membership-invitation.service";
import { MembershipService } from "./membership.service";

/**
 * The invite SCOPE check, which lives in the controller rather than a service and so had no test.
 *
 * Found while auditing every access check whose target scope is nullable (ADR-047). The other
 * three were `MembershipService` twice — which had shipped a cross-Organization leak on exactly
 * this axis — and `WalletService`, which is correct and covered. This one reads correct: it
 * compares `organizationId` first and unconditionally, so the `null === null` short-circuit that
 * broke `MembershipService` cannot arise here.
 *
 * **Reading it was not proof, which is the point of this file.** A rule this project spent a
 * sprint enforcing is that "I read it and it looked right" is the weakest kind of evidence for an
 * access rule — so the path gets a discriminating pair instead.
 */
describe("MembershipController — invite scope (real database)", () => {
  const prisma = new PrismaService();
  let managerRoleId: string;
  let waiterRoleId: string;

  // Only the authorization path is under test; the invitation itself is stubbed so that "was it
  // called" is the observable, and a permitted invite does not need real rows to succeed.
  const invitationService = {
    invite: vi.fn().mockResolvedValue({ id: "stub", token: "stub" }),
  } as unknown as MembershipInvitationService & { invite: ReturnType<typeof vi.fn> };

  const controller = new MembershipController(
    new MembershipService(prisma),
    invitationService,
    prisma,
  );

  beforeAll(async () => {
    await prisma.$connect();
    // Roles and their permissions come from the seeded rows, never a literal (CLAUDE.md).
    managerRoleId = (await prisma.role.findUniqueOrThrow({ where: { name: "Manager" } })).id;
    waiterRoleId = (await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedOrgWithRestaurant() {
    const organization = await prisma.organization.create({
      data: { name: "Invite Scope Org" },
    });
    const currency = await prisma.currency.findUniqueOrThrow({ where: { code: "EUR" } });
    const restaurant = await prisma.restaurant.create({
      data: {
        organizationId: organization.id,
        name: "Scope Test",
        legalName: "Scope Test UAB",
        companyNumber: `CO-${randomUUID()}`,
        vatNumber: `LT${randomUUID()}`,
        email: `${randomUUID()}@example.com`,
        phone: "+37060000000",
        country: "LT",
        currency: currency.code,
        defaultCustomerLocale: "en",
        timezone: "Europe/Vilnius",
        address: "Test address",
      },
    });
    return { organization, restaurant };
  }

  async function callerWith(
    organizationId: string,
    restaurantId: string | null,
    roleName: "Manager" | "Owner",
  ): Promise<AuthenticatedUser> {
    const role = await prisma.role.findUniqueOrThrow({
      where: { name: roleName },
      include: { rolePermissions: { include: { permission: true } } },
    });
    return {
      id: randomUUID(),
      email: `${randomUUID()}@example.com`,
      locale: "en",
      memberships: [
        {
          id: randomUUID(),
          organizationId,
          restaurantId,
          role: {
            id: role.id,
            name: role.name,
            permissions: role.rolePermissions.map((rp) => rp.permission.name),
          },
        },
      ],
    };
  }

  it("a restaurant-scoped Manager cannot invite ORG-WIDE, even holding membership.invite", async () => {
    // The discriminating half. Omitting restaurantId asks for an org-wide Membership — a strictly
    // wider grant than the caller's own scope. Under an implementation that only checked the
    // permission, or that let `dto.restaurantId === m.restaurantId` collapse when both sides are
    // absent, this would succeed.
    const { organization, restaurant } = await seedOrgWithRestaurant();
    const manager = await callerWith(organization.id, restaurant.id, "Manager");

    await expect(
      controller.invite({ email: `${randomUUID()}@example.com`, roleId: waiterRoleId }, manager),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    // Asserted on the effect, not only the thrown code: a rejection that still created the
    // invitation would be the worst outcome to report as a pass.
    expect(invitationService.invite).not.toHaveBeenCalled();
  });

  it("the same Manager CAN invite into its own Restaurant — otherwise the rejection above proves nothing", async () => {
    invitationService.invite.mockClear();
    const { organization, restaurant } = await seedOrgWithRestaurant();
    const manager = await callerWith(organization.id, restaurant.id, "Manager");

    await controller.invite(
      { email: `${randomUUID()}@example.com`, restaurantId: restaurant.id, roleId: waiterRoleId },
      manager,
    );

    expect(invitationService.invite).toHaveBeenCalledTimes(1);
  });

  it("an org-wide Owner CAN invite org-wide in its own Organization", async () => {
    invitationService.invite.mockClear();
    const { organization } = await seedOrgWithRestaurant();
    const owner = await callerWith(organization.id, null, "Owner");

    await controller.invite({ email: `${randomUUID()}@example.com`, roleId: managerRoleId }, owner);

    expect(invitationService.invite).toHaveBeenCalledTimes(1);
  });

  it("an org-wide Owner of a DIFFERENT Organization cannot invite into this Restaurant", async () => {
    invitationService.invite.mockClear();
    const { restaurant } = await seedOrgWithRestaurant();
    const outsiderOrg = await seedOrgWithRestaurant();
    const outsider = await callerWith(outsiderOrg.organization.id, null, "Owner");

    await expect(
      controller.invite(
        { email: `${randomUUID()}@example.com`, restaurantId: restaurant.id, roleId: waiterRoleId },
        outsider,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(invitationService.invite).not.toHaveBeenCalled();
  });
});
