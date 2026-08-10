import { z } from "zod";

// API_Contract.md, ANALYTICS > Dashboard. restaurantId is required, not optional the way
// Transaction List's is: a Dashboard is always exactly one Restaurant's view (UX_MAP.md — an
// org-wide Owner lands on the Restaurants list, never a single combined Dashboard), and a
// restaurant-scoped Manager can hold Memberships at more than one Restaurant, so a bare
// GET /dashboard with no param would be ambiguous about which one is meant.
export const dashboardQuerySchema = z.object({
  restaurantId: z.string().uuid(),
});

export type DashboardQueryDto = z.infer<typeof dashboardQuerySchema>;
