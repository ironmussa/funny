/** Active org on the Better Auth session (`null` = personal workspace). */
export function activeOrganizationIdFromSession(
  data: { session?: { activeOrganizationId?: string | null } } | null | undefined,
): string | null {
  return data?.session?.activeOrganizationId ?? null;
}
