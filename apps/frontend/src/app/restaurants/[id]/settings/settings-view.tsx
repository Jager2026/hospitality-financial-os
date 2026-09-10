"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type JSX } from "react";
import {
  fetchSettings,
  formatMinutesAsClock,
  saveSettings,
  saveTipPresets,
  type EditableSettings,
  type RestaurantSettings,
} from "../../../../lib/api/restaurant-settings";
import { hasPermissionAtRestaurant } from "../../../../lib/auth/permissions";
import { RequireSession } from "../../../../lib/auth/require-session";
import { readSession } from "../../../../lib/auth/session";
import { t } from "../../../../lib/i18n";

/**
 * Venue settings.
 *
 * ── What this screen may edit, and how that was decided ───────────────────────────────────────
 *
 * By asking a running API, not by reading a schema. `PATCH /restaurants/{id}` accepts the create
 * fields minus `country` and `currency`, and its DTO is a plain `z.object` — so anything else is
 * **stripped and answered 200**. That is why the form offers exactly the nine fields that were
 * observed to change the stored row: a control that reports success and changes nothing is worse
 * than no control.
 *
 * **The tip presets looked like a tenth such field and are not.** They cannot go through this
 * endpoint, but they have their own — `PATCH /restaurants/{id}/settings/tips`, built, and guarded
 * by `tips.configure` rather than `restaurant.edit`. A first draft of this screen told the owner
 * they were unchangeable, which would have been a false statement on a customer-facing page;
 * reading the contract rather than only the venue DTO is what caught it.
 *
 * **The shift value has no such second route**, so it is shown and explained rather than offered.
 *
 * ── The shift wording, which matters more than the field ──────────────────────────────────────
 *
 * **A shift lasts until the staff close it.** `shift_auto_close_minutes` is not "when the day
 * ends" — it is the backstop for a shift nobody closed (ADR-064: the button is the main path, this
 * is the net). Saying it the other way round teaches an owner a model of the product that is
 * wrong, and they would then read every shift-scoped figure on the Dashboard through it.
 *
 * The wording was checked for elsewhere and not found: the dictionary and Dashboard captions say
 * "shift" throughout, `UX_MAP.md` describes shifts rather than days, and `DATABASE.md` already
 * calls this "the safety net, never the main path, which is the button".
 */
export function SettingsView({ restaurantId }: { restaurantId: string }): JSX.Element {
  return <RequireSession>{() => <Loaded id={restaurantId} />}</RequireSession>;
}

const FIELD_CLASS =
  "h-control w-full rounded-portal border border-rule bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60";

const EDITABLE_KEYS = [
  "name",
  "legalName",
  "companyNumber",
  "vatNumber",
  "email",
  "phone",
  "address",
  "timezone",
  "defaultCustomerLocale",
] as const;

function Loaded({ id }: { id: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const venue = useQuery({
    queryKey: ["restaurant", id],
    queryFn: async () => {
      const result = await fetchSettings(id);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: (attempt: number, err: unknown) => {
      const status = (err as { status?: number }).status ?? 0;
      if (status === 401 || status === 403) return false;
      return attempt < 2;
    },
  });

  const session = readSession();
  // Whether to OFFER the form. The server decides whether the change is allowed and would refuse
  // regardless — measured: a Waiter and an Accountant both get 403, a Manager 200.
  const mayEdit = hasPermissionAtRestaurant(
    session?.memberships,
    venue.data ?? null,
    "restaurant.edit",
  );
  // A DIFFERENT permission, asked separately — see TipPresets below.
  const mayConfigureTips = hasPermissionAtRestaurant(
    session?.memberships,
    venue.data ?? null,
    "tips.configure",
  );

  if (venue.isPending) return <p className="text-muted">{t("settings.loading")}</p>;
  if (venue.isError) {
    return (
      <section className="max-w-prose space-y-3" data-testid="settings-error">
        <h1 className="text-hero-2 font-semibold">{t("settings.title")}</h1>
        <p className="text-body text-muted">{t("settings.error")}</p>
        <button
          type="button"
          className="h-control rounded-portal border border-rule px-4 text-body"
          onClick={() => void venue.refetch()}
        >
          {t("error.retry")}
        </button>
      </section>
    );
  }

  const current: RestaurantSettings = venue.data;
  const value = (key: keyof EditableSettings): string => draft[key] ?? current[key] ?? "";
  const set = (key: keyof EditableSettings, v: string): void => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: v }));
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(false);

    // Only what actually changed. Sending the whole row would rewrite fields nobody touched, and
    // would make an audit entry claim an edit that did not happen.
    const changes: Partial<EditableSettings> = {};
    for (const key of EDITABLE_KEYS) {
      const next = draft[key];
      if (next !== undefined && next !== current[key]) changes[key] = next;
    }
    if (Object.keys(changes).length === 0) {
      setSaved(true);
      return;
    }

    setSubmitting(true);
    const result = await saveSettings(id, changes);
    setSubmitting(false);

    if (!result.ok) {
      if (result.error.code === "PERMISSION_DENIED") setError(t("settings.error.denied"));
      else if (result.error.code === "NETWORK_UNAVAILABLE")
        setError(t("settings.error.unreachable"));
      else setError(t("settings.error.save"));
      return;
    }

    setDraft({});
    setSaved(true);
    void queryClient.invalidateQueries({ queryKey: ["restaurant", id] });
  }

  return (
    <div className="max-w-prose space-y-8" data-testid="settings">
      <h1 className="text-hero-2 font-semibold">{t("settings.title")}</h1>

      {!mayEdit ? (
        <p className="text-small text-muted" data-testid="settings-readonly">
          {t("settings.forbidden")}
        </p>
      ) : null}

      <form className="space-y-6" onSubmit={(e) => void onSubmit(e)} noValidate>
        <fieldset className="space-y-4" disabled={!mayEdit}>
          <legend className="text-body font-semibold">{t("settings.section.identity")}</legend>
          <Field
            id="name"
            label={t("settings.field.name")}
            hint={t("settings.hint.name")}
            value={value("name")}
            onChange={(v) => set("name", v)}
          />
          <Field
            id="legalName"
            label={t("settings.field.legalName")}
            value={value("legalName")}
            onChange={(v) => set("legalName", v)}
          />
          <Field
            id="companyNumber"
            label={t("settings.field.companyNumber")}
            value={value("companyNumber")}
            onChange={(v) => set("companyNumber", v)}
          />
          <Field
            id="vatNumber"
            label={t("settings.field.vatNumber")}
            value={value("vatNumber")}
            onChange={(v) => set("vatNumber", v)}
          />
        </fieldset>

        <fieldset className="space-y-4" disabled={!mayEdit}>
          <legend className="text-body font-semibold">{t("settings.section.contact")}</legend>
          <Field
            id="email"
            label={t("settings.field.email")}
            value={value("email")}
            onChange={(v) => set("email", v)}
          />
          <Field
            id="phone"
            label={t("settings.field.phone")}
            value={value("phone")}
            onChange={(v) => set("phone", v)}
          />
          <Field
            id="address"
            label={t("settings.field.address")}
            value={value("address")}
            onChange={(v) => set("address", v)}
          />
        </fieldset>

        <fieldset className="space-y-4" disabled={!mayEdit}>
          <legend className="text-body font-semibold">{t("settings.section.operating")}</legend>
          <Field
            id="timezone"
            label={t("settings.field.timezone")}
            hint={t("settings.hint.timezone")}
            value={value("timezone")}
            onChange={(v) => set("timezone", v)}
          />
          <label className="block space-y-1">
            <span className="text-small text-muted">{t("settings.field.locale")}</span>
            <select
              className={FIELD_CLASS}
              value={value("defaultCustomerLocale")}
              onChange={(e) => set("defaultCustomerLocale", e.target.value)}
              data-testid="settings-locale"
            >
              <option value="en">English</option>
              <option value="lt">Lietuvių</option>
            </select>
          </label>
        </fieldset>

        {error !== null ? (
          <p className="text-small text-ink" role="alert" data-testid="settings-save-error">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="text-small text-ink" role="status" data-testid="settings-saved">
            {t("settings.saved")}
          </p>
        ) : null}

        {mayEdit ? (
          <button
            type="submit"
            className="h-control rounded-portal bg-accent px-4 text-body font-medium text-on-accent"
            disabled={submitting}
            data-testid="settings-save"
          >
            {submitting ? t("settings.saving") : t("settings.save")}
          </button>
        ) : null}
      </form>

      {/* ── The two settings the API cannot store, shown rather than offered ─────────────────── */}

      <section className="space-y-2 border-t border-rule pt-6" data-testid="settings-shift">
        <h2 className="text-body font-semibold">{t("settings.shift.heading")}</h2>
        {/* The wording is the point. A shift lasts until it is closed; this is only the backstop. */}
        <p className="text-small text-muted">{t("settings.shift.explain")}</p>
        <p className="text-body text-ink">
          {t("settings.shift.value")}{" "}
          <span data-testid="settings-shift-time">
            {formatMinutesAsClock(current.shiftAutoCloseMinutes)}
          </span>
        </p>
        <p className="text-small text-muted" data-testid="settings-shift-not-editable">
          {t("settings.shift.notEditable")}
        </p>
      </section>

      <TipPresets restaurantId={id} presets={current.tipPresets} mayEdit={mayConfigureTips} />
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="block space-y-1" htmlFor={id}>
      <span className="text-small text-muted">{label}</span>
      <input
        id={id}
        className={FIELD_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`settings-${id}`}
      />
      {hint !== undefined ? <span className="block text-small text-muted">{hint}</span> : null}
    </label>
  );
}

/**
 * The tip presets, which are a separate endpoint with a separate permission.
 *
 * **`tips.configure`, not `restaurant.edit`.** The seed happens to grant both to the same three
 * Roles, so today they coincide — but they are two rules, and collapsing them is how a screen
 * starts offering a control the server refuses. Asked separately for that reason.
 *
 * **The values are a display suggestion, never a limit** (ADR-022): the terminal computes the real
 * amount from whichever preset — or Custom — the guest picks, and the server only ever checks that
 * the tip does not exceed the bill. The caption says so, because "10 · 15 · 20" on a settings
 * screen otherwise reads as a rule about what a guest is allowed to leave.
 */
function TipPresets({
  restaurantId,
  presets,
  mayEdit,
}: {
  restaurantId: string;
  presets: number[];
  mayEdit: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(presets.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(false);

    // The endpoint takes positive integers and at least one of them. Parsed here so the person is
    // told what is wrong in their own words rather than being handed a 400 from a schema.
    const parsed = draft
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => Number(part));
    if (parsed.length === 0 || parsed.some((n) => !Number.isInteger(n) || n <= 0)) {
      setError(t("settings.tips.error.invalid"));
      return;
    }

    setSubmitting(true);
    const result = await saveTipPresets(restaurantId, parsed);
    setSubmitting(false);

    if (!result.ok) {
      if (result.error.code === "PERMISSION_DENIED") setError(t("settings.tips.error.denied"));
      else setError(t("settings.tips.error.save"));
      return;
    }
    setSaved(true);
    void queryClient.invalidateQueries({ queryKey: ["restaurant", restaurantId] });
  }

  return (
    <section className="space-y-2 border-t border-rule pt-6" data-testid="settings-tips">
      <h2 className="text-body font-semibold">{t("settings.tips.heading")}</h2>
      <p className="text-small text-muted">{t("settings.tips.explain")}</p>
      <p className="text-body text-ink" data-testid="settings-tip-presets">
        {presets.map((p) => `${p}%`).join(" · ")}
      </p>

      {mayEdit ? (
        <form className="space-y-3" onSubmit={(e) => void onSubmit(e)} noValidate>
          <label className="block space-y-1">
            <span className="text-small text-muted">{t("settings.tips.field")}</span>
            <input
              className={FIELD_CLASS}
              value={draft}
              onChange={(e) => {
                setSaved(false);
                setDraft(e.target.value);
              }}
              data-testid="settings-tips-input"
            />
          </label>
          {error !== null ? (
            <p className="text-small text-ink" role="alert" data-testid="settings-tips-error">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p className="text-small text-ink" role="status" data-testid="settings-tips-saved">
              {t("settings.saved")}
            </p>
          ) : null}
          <button
            type="submit"
            className="h-control rounded-portal border border-rule px-4 text-body"
            disabled={submitting}
            data-testid="settings-tips-save"
          >
            {submitting ? t("settings.saving") : t("settings.tips.save")}
          </button>
        </form>
      ) : (
        <p className="text-small text-muted" data-testid="settings-tips-readonly">
          {t("settings.tips.denied")}
        </p>
      )}
    </section>
  );
}
