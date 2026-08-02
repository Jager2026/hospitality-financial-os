import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSION_KEY = "requiredPermission";

/** Marks a route as requiring a named Permission, checked by PermissionsGuard against the
 * current User's Memberships (DOMAIN_GLOSSARY.md: "entirely data-driven through the
 * RolePermission table; no permission check anywhere should hardcode a role by name" — this
 * decorator names a Permission, never a Role). Must run after JwtAuthGuard. */
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
