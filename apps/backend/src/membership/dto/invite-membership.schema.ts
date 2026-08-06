import { z } from "zod";

// API_Contract.md, MEMBERSHIPS: POST /memberships — restaurantId omitted means an org-wide role
// (ADR-005), mirrored exactly onto the resulting Membership at acceptance (ADR-020).
export const inviteMembershipSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  restaurantId: z.string().uuid().optional(),
  roleId: z.string().uuid(),
});

export type InviteMembershipDto = z.infer<typeof inviteMembershipSchema>;
