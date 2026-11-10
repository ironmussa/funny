/**
 * Known user roles. Any role not in this set is coerced to `'user'` by the
 * auth middleware so that a value leaking in from an untrusted source cannot
 * silently grant elevated privileges.
 */
const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Narrow an untrusted value to a known UserRole, defaulting to 'user'. */
export function normalizeUserRole(raw: unknown): UserRole {
  return typeof raw === 'string' && (USER_ROLES as readonly string[]).includes(raw)
    ? (raw as UserRole)
    : 'user';
}

/** Hono environment type for context variables set by auth middleware. */
export type ServerEnv = {
  Bindings: {
    runnerRequests?: import('../services/runner-ports.js').RunnerRequestPort;
    runnerPresence?: import('../services/runner-ports.js').RunnerPresencePort;
    browserEvents?: import('../services/runner-ports.js').BrowserEventSink;
    /** TCP peer address of this request, supplied by the host (see lib/client-ip.ts). */
    IP?: import('./client-ip.js').ClientAddress | null;
  };
  Variables: {
    userId: string;
    userRole: UserRole;
    isRunner: boolean;
    isScheduler: boolean;
    isSchedulerSystem: boolean;
    runnerId: string;
    organizationId: string | null;
    organizationName: string | null;
    /**
     * The thread resolved + authorized by `requireThreadView` /
     * `requireThreadOwner` (see middleware/thread-access.ts). Present only on
     * routes guarded by those middlewares; handlers read it via `c.get('thread')`
     * instead of re-fetching. Typed loosely as the shared `Thread` shape.
     */
    thread: import('@funny/shared').Thread;
    /**
     * Set by the auth middleware when `POST /api/runners/register` carries a
     * valid `X-Runner-Provision-Token` (thread-sandboxes): the runner becomes the
     * sandbox runner of this grant's thread.
     */
    provisionGrant?: import('../services/runner-provision-tokens.js').ProvisionGrant;
  };
};
