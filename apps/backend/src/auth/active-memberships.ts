import type { Prisma } from "@prisma/client";

/**
 * The single definition of "which Memberships count as this person's, right now".
 *
 * **This exists because `PATCH /memberships/{id}/disable` did nothing.** It set
 * `Membership.status = "INACTIVE"` and the disabled person kept every permission they had:
 * `JwtAuthGuard` loaded `user.memberships` unfiltered, `AuthenticatedUser` carried no `status`
 * field at all, and so neither `PermissionsGuard` nor `restaurant-reachability.util.ts` could have
 * consulted one even if they had wanted to. The only `status !== "ACTIVE"` check in the auth path
 * is on the **User** — a different row, untouched by disabling a Membership. Proven by execution
 * (`e2e/disabled-membership.e2e.spec.ts`), not by reading: a disabled Manager read the
 * restaurant's dashboard with a token minted *after* the disable.
 *
 * **Filtering at the query is the decision, rather than adding `status` to `AuthenticatedUser` and
 * checking it downstream.** There are two Guards and six services reading `user.memberships`; a
 * rule they each have to remember is a rule that gets forgotten once, in the file nobody looked
 * at. Excluding the rows at the one place they enter the request makes "the caller holds this
 * Membership" mean "…and it is currently in force" everywhere, with nothing to remember.
 *
 * **`deletedAt` is included even though nothing writes it on a Membership today.** It is free
 * here, and it is the filter that has to already be in place on the day an erasure path exists
 * (`PERSONAL_DATA_MAP.md` §4) — otherwise soft-deleting a person would be the same silent no-op
 * this file was written to close.
 *
 * Both consumers import from here rather than repeating the object. `AuthService.toAuthResult`'s
 * own comment already said "same query shape as JwtAuthGuard's own", which is a promise that two
 * literals will stay equal — and this codebase has twice paid for exactly that promise
 * (`global-setup.ts`'s permission matrix, the hand-typed Role fixtures).
 */
export const ACTIVE_MEMBERSHIP_WHERE = {
  status: "ACTIVE",
  deletedAt: null,
} satisfies Prisma.MembershipWhereInput;

/** The Role and its Permissions, which every consumer of `AuthenticatedUser.memberships` needs to
 * answer a permission question. Separate from the `where` above because one is about which rows
 * and the other about how deep to read them. */
export const MEMBERSHIP_ROLE_INCLUDE = {
  role: { include: { rolePermissions: { include: { permission: true } } } },
} satisfies Prisma.MembershipInclude;
