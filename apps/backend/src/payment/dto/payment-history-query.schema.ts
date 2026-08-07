import { z } from "zod";

// API_Contract.md, Payment History: "pagination, sorting, filtering." Sorting is fixed
// (createdAt desc) for MVP — no client-supplied sort field yet, matching the same minimal scope
// this session applied elsewhere (e.g. the single-organization assumption in Membership invites).
export const paymentHistoryQuerySchema = z.object({
  restaurantId: z.string().uuid().optional(),
  status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "CANCELED", "DECLINED"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type PaymentHistoryQueryDto = z.infer<typeof paymentHistoryQuerySchema>;
