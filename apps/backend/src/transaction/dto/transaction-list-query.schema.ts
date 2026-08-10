import { z } from "zod";

// API_Contract.md, Transaction List. Sorting is fixed (createdAt desc) for MVP — same "no
// client-supplied sort field yet" precedent as Payment History.
export const transactionListQuerySchema = z.object({
  restaurantId: z.string().uuid().optional(),
  status: z.enum(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"]).optional(),
  membership: z.string().uuid().optional(), // Payment.waiterMembershipId — a Waiter's own Transactions
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type TransactionListQueryDto = z.infer<typeof transactionListQuerySchema>;

// GET /transactions/export — same filters, no pagination.
export const transactionExportQuerySchema = transactionListQuerySchema.omit({
  page: true,
  limit: true,
});

export type TransactionExportQueryDto = z.infer<typeof transactionExportQuerySchema>;
