import { authedGet, authedPost } from "../auth/authed-fetch";
import { apiPost, type ApiResult } from "./client";

/**
 * The staff and invitation endpoints (API_Contract.md, MEMBERSHIPS).
 *
 * Shapes declared here rather than imported from the backend — the Portal is a separate build with
 * its own `rootDir`, and this is the ordinary client/server boundary duplication, the same reason
 * `CurrentAgreements` is declared in `agreements.ts`.
 *
 * The authenticated calls go through `authedGet`/`authedPost` rather than the token-passing
 * variants, so a request that meets an expired access token is retried after a refresh instead of
 * signing the person out mid-task.
 */

/**
 * What `GET /restaurants/{id}/staff` actually returns, measured rather than assumed.
 *
 * **There is no status field, and that is not an omission on this side.** The route was built as
 * the terminal's "who served this table" picker (ADR-033) and filters `status: ACTIVE`, so it
 * reports people who hold a Membership and nothing else. A pending invitation is a
 * `MembershipInvitation` row — a different table — and **no endpoint exposes one**, which is why
 * the staff screen says so in words instead of showing a column it cannot fill.
 */
export interface StaffMember {
  id: string;
  displayName: string;
  email: string;
  roleName: string;
}

/** `GET /roles` — assignable Roles only; platform-only ones are omitted server-side (ADR-044). */
export interface AssignableRole {
  id: string;
  name: string;
  description: string | null;
}

export async function fetchStaff(restaurantId: string): Promise<ApiResult<StaffMember[]>> {
  return await authedGet<StaffMember[]>(`/restaurants/${restaurantId}/staff`);
}

/**
 * Requires `membership.invite` — the same permission the invitation itself needs. A caller who
 * cannot invite therefore cannot read the Roles either, which is why the invite form is not
 * offered at all rather than offered and then refused.
 */
export async function fetchAssignableRoles(): Promise<ApiResult<AssignableRole[]>> {
  return await authedGet<AssignableRole[]>("/roles");
}

export interface InvitationCreated {
  id: string;
  email: string;
}

/**
 * `POST /memberships`. The response carries an id and the address — **never the token**, which
 * goes to the email and nowhere else (ADR-070). A screen that displayed a token would make the
 * mail path the one nobody exercises.
 */
export async function inviteToRestaurant(input: {
  email: string;
  roleId: string;
  restaurantId: string;
}): Promise<ApiResult<InvitationCreated>> {
  return await authedPost<InvitationCreated>("/memberships", input);
}

/**
 * What the accept screen submits. `password`, `displayName` and `acceptedTermsVersion` are sent
 * only when this request is the one creating the account — the server requires them exactly then,
 * and sending them for an existing account would ask somebody to agree to the terms twice.
 */
export interface AcceptInvitationInput {
  email: string;
  token: string;
  password?: string;
  displayName?: string;
  acceptedTermsVersion?: string;
}

/** Public — the invitee has no session yet, and the token in the link is the credential. */
export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<ApiResult<{ id: string }>> {
  return await apiPost<{ id: string }>("/memberships/invitations/accept", input);
}
