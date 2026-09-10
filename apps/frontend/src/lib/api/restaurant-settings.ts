import { authedGet, authedPatch } from "../auth/authed-fetch";
import type { ApiResult } from "./client";

/**
 * The venue's own settings (API_Contract.md, RESTAURANTS).
 *
 * ── What `PATCH /restaurants/{id}` actually accepts, measured against a running API ───────────
 *
 * The editable set is `createRestaurantSchema` minus `country` and `currency`, all optional. Two
 * things about it decided the shape of the settings screen and are recorded here rather than
 * rediscovered:
 *
 * **Unknown fields are silently ignored, not refused.** The DTO is a plain `z.object`, which
 * STRIPS what it does not know, so `PATCH { shiftAutoCloseMinutes: 240 }` answers **200** and the
 * stored value stays **300**. Measured. A settings screen that offered those fields would report
 * success and change nothing — the worst of the three possible behaviours, and the reason this
 * module does not expose a setter for them.
 *
 * **`acceptedStripeAgreementVersion` is accepted by the schema and rejected by the database.** It
 * is not a `Restaurant` column, and `update` passes the DTO straight to Prisma, so sending it is a
 * **500 `UNKNOWN_ERROR`** — measured, not inferred. It is therefore deliberately absent from the
 * editable type below: it is a create-time field that the update schema inherited by being derived
 * from the create one.
 */
export interface RestaurantSettings {
  id: string;
  name: string;
  legalName: string;
  companyNumber: string;
  vatNumber: string;
  email: string;
  phone: string;
  address: string;
  timezone: string;
  defaultCustomerLocale: string;
  country: string;
  currency: string;
  organizationId: string;
  /** Minutes after local midnight at which an unclosed shift closes itself. Read-only here: the
   * update endpoint has no field for it (ADR-064 owns the value). */
  shiftAutoCloseMinutes: number;
  /** Percentages offered at Tip Selection — display suggestions only (ADR-022). Editable, but
   * through its OWN route rather than this one: `PATCH /restaurants/{id}/settings/tips`, which
   * requires `tips.configure` instead of `restaurant.edit`. */
  tipPresets: number[];
}

/** Exactly the fields `PATCH` both accepts and can store. Nothing here is guessed: each one was
 * sent to a running API and observed to change the stored row. */
export interface EditableSettings {
  name: string;
  legalName: string;
  companyNumber: string;
  vatNumber: string;
  email: string;
  phone: string;
  address: string;
  timezone: string;
  defaultCustomerLocale: string;
}

export async function fetchSettings(restaurantId: string): Promise<ApiResult<RestaurantSettings>> {
  return await authedGet<RestaurantSettings>(`/restaurants/${restaurantId}`);
}

export async function saveSettings(
  restaurantId: string,
  changes: Partial<EditableSettings>,
): Promise<ApiResult<RestaurantSettings>> {
  return await authedPatch<RestaurantSettings>(`/restaurants/${restaurantId}`, changes);
}

/**
 * `300` → `"05:00"`. The stored value is minutes after the venue's own local midnight (ADR-064),
 * so this is arithmetic on a clock face rather than a date — no timezone conversion belongs here,
 * because the number is already local to the venue.
 */
export function formatMinutesAsClock(minutes: number): string {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.min(1439, Math.trunc(minutes))) : 0;
  const hh = String(Math.floor(safe / 60)).padStart(2, "0");
  const mm = String(safe % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The tip presets, which have their own endpoint and their own permission.
 *
 * **Found by reading the contract rather than assumed from the venue DTO.** `PATCH
 * /restaurants/{id}` cannot store them — like the shift value, they are stripped and answered 200 —
 * but `PATCH /restaurants/{id}/settings/tips` can, and it exists and is built. A first draft of
 * this screen told the owner they could not be changed, which would have been a false statement on
 * a customer-facing page.
 *
 * The permission differs too: `tips.configure`, not `restaurant.edit`. The seed grants both to
 * Owner, Administrator and Manager, so the two happen to coincide today — but they are two rules,
 * and treating them as one is how a screen starts offering a control the server will refuse.
 */
export interface TipSettings {
  presetTips: number[];
}

export async function saveTipPresets(
  restaurantId: string,
  presetTips: number[],
): Promise<ApiResult<TipSettings>> {
  return await authedPatch<TipSettings>(`/restaurants/${restaurantId}/settings/tips`, {
    presetTips,
  });
}
