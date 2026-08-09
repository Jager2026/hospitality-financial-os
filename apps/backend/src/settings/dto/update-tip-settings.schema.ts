import { z } from "zod";

// API_Contract.md, Tip Configuration (Sprint 6, ADR-022).
export const updateTipSettingsSchema = z.object({
  presetTips: z.array(z.number().int().positive()).min(1),
});

export type UpdateTipSettingsDto = z.infer<typeof updateTipSettingsSchema>;
