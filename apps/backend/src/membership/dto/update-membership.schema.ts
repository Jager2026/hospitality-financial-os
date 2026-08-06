import { z } from "zod";

// API_Contract.md, Update Membership: role reassignment (IMPLEMENTATION_PLAN.md Sprint 4, "Role
// Assignment"). organizationId/restaurantId/userId are never editable — reinviting under a
// different scope is a new invitation, not an edit to an existing Membership.
export const updateMembershipSchema = z.object({
  roleId: z.string().uuid().optional(),
});

export type UpdateMembershipDto = z.infer<typeof updateMembershipSchema>;
