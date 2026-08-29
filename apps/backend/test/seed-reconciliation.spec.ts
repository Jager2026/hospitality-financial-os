import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findStaleGrants, seedRbac } from "../prisma/seed";

/**
 * ADR-046. `seedRbac` used to be able to add and correct, never to remove: the RolePermission loop
 * was an `upsert` and nothing else, so deleting a Permission from a Role in `seed.ts` changed
 * nothing on a database that already held the row. A permission granted once stayed granted.
 *
 * These run against the real database, like every other seed-adjacent test here, and they matter
 * because the wrong implementation is not hypothetical — it is what shipped for twelve sprints.
 * Each assertion below FAILS against that previous version, which is the only reason to trust it
 * (CLAUDE.md, Testing Philosophy).
 */

const prisma = new PrismaClient();

beforeAll(async () => {
  // Bring the matrix to its intended state first, so a leftover row from another run cannot make
  // these tests pass or fail for reasons unrelated to what they assert.
  await seedRbac(prisma);
});

afterAll(async () => {
  await seedRbac(prisma);
  await prisma.$disconnect();
});

describe("seedRbac reconciles RolePermission rather than only adding to it", () => {
  it("revokes a grant the matrix does not intend — the case the upsert-only version could not reach", async () => {
    const waiter = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
    const dangerous = await prisma.permission.findUniqueOrThrow({
      where: { name: "roles.manage" },
    });

    // Exactly the shape of the real hazard: a row that exists in the database and appears nowhere
    // in seed.ts. Waiter is chosen because its intended set is EMPTY, which is also the branch
    // where `notIn: []` semantics would have decided the outcome had the implementation relied on
    // them — so this covers the empty-set path rather than only the ordinary one.
    await prisma.rolePermission.create({
      data: { roleId: waiter.id, permissionId: dangerous.id },
    });

    await seedRbac(prisma);

    const after = await prisma.rolePermission.findMany({ where: { roleId: waiter.id } });
    expect(after).toHaveLength(0);
  });

  it("leaves every intended grant in place — a reconciliation that revoked broadly would also pass the test above", async () => {
    // The discriminating half. Without it, an implementation that simply deleted every
    // RolePermission row for a seeded Role would satisfy the first test perfectly.
    const owner = await prisma.role.findUniqueOrThrow({
      where: { name: "Owner" },
      include: { rolePermissions: true },
    });
    const manager = await prisma.role.findUniqueOrThrow({
      where: { name: "Manager" },
      include: { rolePermissions: true },
    });
    const permissionCount = await prisma.permission.count();

    expect(owner.rolePermissions).toHaveLength(permissionCount);
    expect(manager.rolePermissions.length).toBeGreaterThan(0);
    expect(manager.rolePermissions.length).toBeLessThan(permissionCount);
  });

  // findStaleGrants is what the command-line gate reads to decide whether to stop and ask
  // (ADR-046 addendum). It has to be read-only, and it has to see exactly what seedRbac would
  // delete — a preview that disagreed with the action would be worse than no preview.
  describe("findStaleGrants — the preview the confirmation gate is built on", () => {
    it("names the grant that would be revoked, and does not revoke it", async () => {
      const waiter = await prisma.role.findUniqueOrThrow({ where: { name: "Waiter" } });
      const dangerous = await prisma.permission.findUniqueOrThrow({
        where: { name: "roles.manage" },
      });
      await prisma.rolePermission.create({
        data: { roleId: waiter.id, permissionId: dangerous.id },
      });

      const planned = await findStaleGrants(prisma);

      expect(planned).toContainEqual(
        expect.objectContaining({ role: "Waiter", permission: "roles.manage" }),
      );
      // Read-only is the whole point: an operator who is shown this and declines must still have
      // the row. Asserted, because "it only reads" is exactly the kind of claim that stops being
      // true when someone later reuses the helper.
      const stillThere = await prisma.rolePermission.findMany({ where: { roleId: waiter.id } });
      expect(stillThere).toHaveLength(1);

      await seedRbac(prisma);
      expect(await findStaleGrants(prisma)).toHaveLength(0);
    });

    it("reports nothing when the database already matches the matrix — otherwise the gate would block every ordinary run", async () => {
      await seedRbac(prisma);
      expect(await findStaleGrants(prisma)).toHaveLength(0);
    });
  });

  it("does not touch a Role it does not define — the seed's authority stops at its own matrix", async () => {
    // The recorded safety boundary, asserted rather than trusted to the comment that states it.
    // A Role absent from seed.ts was created by something else; reconciling it would be the seed
    // revoking grants it never made and cannot know about.
    const foreign = await prisma.role.create({
      data: { name: `Auditor-${Date.now()}`, description: "Not defined in seed.ts" },
    });
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { name: "reports.view" },
    });
    await prisma.rolePermission.create({
      data: { roleId: foreign.id, permissionId: permission.id },
    });

    await seedRbac(prisma);

    const survived = await prisma.rolePermission.findMany({ where: { roleId: foreign.id } });
    expect(survived).toHaveLength(1);

    await prisma.rolePermission.deleteMany({ where: { roleId: foreign.id } });
    await prisma.role.delete({ where: { id: foreign.id } });
  });
});
