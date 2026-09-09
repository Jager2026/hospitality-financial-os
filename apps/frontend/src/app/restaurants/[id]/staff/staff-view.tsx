"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type JSX } from "react";
import {
  fetchAssignableRoles,
  fetchStaff,
  inviteToRestaurant,
  type AssignableRole,
  type StaffMember,
} from "../../../../lib/api/staff";
import { readSession } from "../../../../lib/auth/session";
import { hasPermissionAtRestaurant } from "../../../../lib/auth/permissions";
import { RequireSession } from "../../../../lib/auth/require-session";
import { authedGet } from "../../../../lib/auth/authed-fetch";
import { t } from "../../../../lib/i18n";

/**
 * Staff — the list of people who work here, and the form that invites the next one.
 *
 * ── What this screen cannot show, and why it says so ──────────────────────────────────────────
 *
 * **A pending invitation.** `GET /restaurants/{id}/staff` filters `status: ACTIVE` and returns
 * `{id, displayName, email, roleName}` — no status field — because it was built as the terminal's
 * "who served this table" picker (ADR-033). A sent-but-unaccepted invitation is a
 * `MembershipInvitation` row in a different table, and **no endpoint reports one**. Established by
 * reading every route on the controller, not assumed.
 *
 * So the screen states the gap in a sentence rather than leaving it to be discovered. "I invited
 * Jonas yesterday and he is not in the list" is otherwise indistinguishable from a fault, and a
 * person who concludes the product is broken is not wrong to.
 *
 * **Revoking one.** There is no route for it either — unchanged since it was last measured. Not
 * built here: a button that cannot call anything is worse than its absence.
 */

const FIELD_CLASS =
  "h-control w-full rounded-portal border border-rule bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent";

interface VenueScope {
  id: string;
  organizationId: string;
  name: string;
}

export function StaffView({ restaurantId }: { restaurantId: string }): JSX.Element {
  return <RequireSession>{() => <Loaded id={restaurantId} />}</RequireSession>;
}

function Loaded({ id }: { id: string }): JSX.Element {
  const retryUnlessRefused = (attempt: number, error: unknown): boolean => {
    const status = (error as { status?: number }).status ?? 0;
    if (status === 401 || status === 403) return false;
    return attempt < 2;
  };

  const venue = useQuery({
    queryKey: ["restaurant", id],
    queryFn: async () => {
      const result = await authedGet<VenueScope>(`/restaurants/${id}`);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  const staff = useQuery({
    queryKey: ["staff", id],
    queryFn: async () => {
      const result = await fetchStaff(id);
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: retryUnlessRefused,
  });

  // Whether to OFFER the form, never whether the invitation is allowed — the server decides that
  // and would refuse regardless (`permissions.ts` says this at length). Offering a form that will
  // be refused teaches an owner's staff that the product is broken when it is working as designed.
  const session = readSession();
  const mayInvite = hasPermissionAtRestaurant(
    session?.memberships,
    venue.data ?? null,
    "membership.invite",
  );

  if (staff.isPending) return <p className="text-muted">{t("staff.loading")}</p>;
  if (staff.isError) {
    return (
      <section className="max-w-prose space-y-3" data-testid="staff-error">
        <h1 className="text-hero-2 font-semibold">{t("staff.title")}</h1>
        <p className="text-body text-muted">{t("staff.error")}</p>
        <button
          type="button"
          className="h-control rounded-portal border border-rule px-4 text-body"
          onClick={() => void staff.refetch()}
        >
          {t("error.retry")}
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-8" data-testid="staff">
      <header className="space-y-2">
        <h1 className="text-hero-2 font-semibold">{t("staff.title")}</h1>
        {/* The limit of the list, said once and plainly. */}
        <p className="max-w-prose text-small text-muted" data-testid="staff-pending-note">
          {t("staff.pendingNote")}
        </p>
      </header>

      {staff.data.length === 0 ? (
        <section className="max-w-prose space-y-2" data-testid="staff-empty">
          <h2 className="text-body font-semibold">{t("staff.empty.title")}</h2>
          <p className="text-small text-muted">{t("staff.empty.body")}</p>
        </section>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule" data-testid="staff-list">
          {staff.data.map((person: StaffMember) => (
            <li
              key={person.id}
              className="flex items-baseline justify-between gap-4 py-3"
              data-testid="staff-row"
            >
              <span className="space-y-0.5">
                <span className="block text-body text-ink">{person.displayName}</span>
                <span className="block text-small text-muted">{person.email}</span>
              </span>
              <span className="text-small text-muted" data-testid="staff-role">
                {person.roleName}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mayInvite ? <InviteForm restaurantId={id} /> : null}
    </div>
  );
}

function InviteForm({ restaurantId }: { restaurantId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const roles = useQuery({
    queryKey: ["assignable-roles"],
    queryFn: async () => {
      const result = await fetchAssignableRoles();
      if (!result.ok) throw result.error;
      return result.data;
    },
    retry: false,
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSentTo(null);

    // Checked here rather than by disabling the button: a disabled control states that something
    // is wrong without saying what (DESIGN_SYSTEM.md — clarity comes from explanation, never from
    // suppression).
    if (email.trim() === "") {
      setError(t("staff.invite.error.email"));
      return;
    }
    if (roleId === "") {
      setError(t("staff.invite.error.role"));
      return;
    }

    setSubmitting(true);
    const result = await inviteToRestaurant({ email: email.trim(), roleId, restaurantId });
    setSubmitting(false);

    if (!result.ok) {
      // The throttle explained in words rather than shown as a fault. 429 here is the product
      // working: five a minute is the deliberate limit (ADR-070), set to protect the address our
      // mail leaves from, and the message says what to do next rather than only what happened.
      if (result.error.status === 429) setError(t("staff.invite.error.tooMany"));
      else if (result.error.code === "PERMISSION_DENIED") setError(t("staff.invite.error.denied"));
      else if (result.error.code === "NETWORK_UNAVAILABLE")
        setError(t("staff.invite.error.unreachable"));
      else setError(t("staff.invite.error.generic"));
      return;
    }

    setSentTo(result.data.email);
    setEmail("");
    setRoleId("");
    // The invited person does not appear until they accept, so this cannot show them — it is
    // refetched anyway because an invitation accepted in another tab, or by somebody who was
    // invited earlier, is exactly the change worth picking up while this screen is open.
    void queryClient.invalidateQueries({ queryKey: ["staff", restaurantId] });
  }

  return (
    <section className="max-w-prose space-y-4 border-t border-rule pt-6" data-testid="staff-invite">
      <h2 className="text-body font-semibold">{t("staff.invite.heading")}</h2>

      {roles.isError ? (
        <p className="text-small text-muted" data-testid="staff-roles-unavailable">
          {t("staff.rolesUnavailable")}
        </p>
      ) : (
        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)} noValidate>
          <label className="block space-y-1">
            <span className="text-small text-muted">{t("staff.invite.email")}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={FIELD_CLASS}
              data-testid="staff-invite-email"
              autoComplete="off"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-small text-muted">{t("staff.invite.role")}</span>
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              className={FIELD_CLASS}
              data-testid="staff-invite-role"
            >
              <option value="">{t("staff.invite.rolePlaceholder")}</option>
              {(roles.data ?? []).map((role: AssignableRole) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>

          {error !== null ? (
            <p className="text-small text-ink" role="alert" data-testid="staff-invite-error">
              {error}
            </p>
          ) : null}

          {sentTo !== null ? (
            <p className="text-small text-ink" role="status" data-testid="staff-invite-sent">
              {t("staff.invite.sent")}
            </p>
          ) : null}

          <button
            type="submit"
            className="h-control rounded-portal bg-accent px-4 text-body font-medium text-on-accent"
            disabled={submitting}
            data-testid="staff-invite-submit"
          >
            {submitting ? t("staff.invite.sending") : t("staff.invite.submit")}
          </button>
        </form>
      )}
    </section>
  );
}
