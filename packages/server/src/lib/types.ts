/**
 * Known user roles. Any role not in this set is coerced to `'user'` by the
 * auth middleware so that a value leaking in from an untrusted source cannot
 * silently grant elevated privileges.
 */
export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Narrow an untrusted value to a known UserRole, defaulting to 'user'. */
export function normalizeUserRole(raw: unknown): UserRole {
  return typeof raw === 'string' && (USER_ROLES as readonly string[]).includes(raw)
    ? (raw as UserRole)
    : 'user';
}

/** Hono environment type for context variables set by auth middleware. */
export type ServerEnv = {
  Variables: {
    userId: string;
    userRole: UserRole;
    isRunner: boolean;
    isOrchestrator: boolean;
    isOrchestratorSystem: boolean;
    runnerId: string;
    organizationId: string | null;
    organizationName: string | null;
  };
};
