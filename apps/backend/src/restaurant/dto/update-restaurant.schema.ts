import { z } from "zod";
import { createRestaurantSchema } from "./create-restaurant.schema";

// country/currency are excluded — immutable once set (see create-restaurant.schema.ts's comment,
// DATABASE.md Rules).
export const updateRestaurantSchema = createRestaurantSchema
  .omit({ country: true, currency: true })
  .partial();

export type UpdateRestaurantDto = z.infer<typeof updateRestaurantSchema>;
