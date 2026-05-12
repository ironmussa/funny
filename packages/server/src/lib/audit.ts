/**
 * Audit logger for sensitive operations.
 *
 * Emits structured log entries via the server logger with a dedicated
 * "audit" namespace so they can be filtered, forwarded to Abbacchio,
 * and reviewed independently from application logs.
 */

import { log } from './logger.js';

export type AuditAction =
  | 'user.create'
  | 'user.delete'
  | 'user.login'
  | 'user.login_failed'
  | 'user.password_change'
  | 'token.create'
  | 'token.revoke'
  | 'runner.register'
  | 'runner.remove'
  | 'invite.create'
  | 'invite.accept'
  | 'invite.revoke'
  | 'project.create'
  | 'project.delete'
  | 'org.create'
  | 'org.delete'
  | 'settings.update'
  /** Session rejected by middleware (missing/invalid cookie, unparseable session). */
  | 'auth.session_rejected'
  /** Session role unexpected; coerced to least-privileged 'user' (H8 fallback). */
  | 'auth.role_coerced'
  /** Request carrying an unauthorized runner secret or token was rejected. */
  | 'auth.runner_rejected'
  /** Request carrying an orchestrator secret without X-Forwarded-User was rejected. */
  | 'auth.orchestrator_rejected'
  /** Runner-scoped resource access refused because runner.userId ≠ requester/owner. */
  | 'authz.cross_tenant_refused';

interface AuditEntry {
  action: AuditAction;
  /** The user performing the action (null for unauthenticated actions like failed login). */
  actorId: string | null;
  /** Human-readable description. */
  detail?: string;
  /** Arbitrary structured metadata. */
  meta?: Record<string, unknown>;
}

/**
 * Record an auditable event.
 * Always logged at "info" level so it persists in file rotation and Abbacchio.
 */
export function audit(entry: AuditEntry): void {
  log.info(`[AUDIT] ${entry.action}`, {
    namespace: 'audit',
    action: entry.action,
    actorId: entry.actorId,
    detail: entry.detail,
    ...entry.meta,
  });
}
