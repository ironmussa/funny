/**
 * Shared password strength policy.
 *
 * Centralizes the rules so they can't drift between the invite-link
 * registration path (`routes/invite-links.ts`) and the bootstrap admin
 * seeding path (`lib/auth.ts`) — Security M5 was filed because the latter
 * accepted any value of `ADMIN_PASSWORD` without checking against the same
 * rules the rest of the app enforces.
 */

export interface PasswordPolicyResult {
  ok: boolean;
  /** Human-readable reason when `ok === false`. */
  reason?: string;
}

/**
 * Returns `{ ok: true }` if `password` meets the policy, otherwise the
 * first violated rule. Match the existing invite-link enforcement:
 *   - at least 10 characters,
 *   - contains at least one uppercase, one lowercase, and one digit.
 *
 * Symbols are NOT required (existing UX); keep the policy in lockstep with
 * `routes/invite-links.ts` so a user can't pick a password that one path
 * accepts and the other rejects.
 */
export function validatePasswordStrength(password: unknown): PasswordPolicyResult {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, reason: 'Password is required' };
  }
  if (password.length < 10) {
    return { ok: false, reason: 'Password must be at least 10 characters long' };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return {
      ok: false,
      reason: 'Password must contain uppercase, lowercase, and numeric characters',
    };
  }
  return { ok: true };
}
