/**
 * Shared password strength policy.
 *
 * Centralizes the rules so they can't drift between the invite-link
 * registration path (`routes/invite-links.ts`) and the bootstrap admin
 * seeding path (`lib/auth.ts`) — Security M5 was filed because the latter
 * accepted any value of `ADMIN_PASSWORD` without checking against the same
 * rules the rest of the app enforces.
 */

import { z } from 'zod';

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
export function validatePasswordStrength(password: string | undefined): PasswordPolicyResult {
  if (password === undefined || password.length === 0) {
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

/** Auth path → the body field carrying its password. */
interface PasswordFieldByAuthPath {
  [path: string]: keyof AuthRequestPasswords;
}

/**
 * Better Auth endpoints that set a password, and the body field carrying it.
 * Better Auth itself checks only its own minimum length on some of these, and
 * none on `/admin/create-user` (issue #201), so `lib/auth.ts` runs the policy
 * above on every one of them in a `before` hook. Add an endpoint here when a
 * new plugin or route can set a password.
 */
const PASSWORD_FIELD_BY_AUTH_PATH: PasswordFieldByAuthPath = {
  '/sign-up/email': 'password',
  '/change-password': 'newPassword',
  '/reset-password': 'newPassword',
  '/set-password': 'newPassword',
  '/admin/create-user': 'password',
  '/admin/set-user-password': 'newPassword',
};

/**
 * A password field of a request body: absent, or the text to check. Any other
 * value (a number, `null`, an object) parses as `''`, which the policy rejects
 * as missing, like a value that is not text.
 */
const passwordField = z.string().optional().catch('');

/**
 * The password fields of a Better Auth request body, parsed from the raw body.
 * A body that is not an object carries no password field.
 */
export const authRequestPasswordsSchema = z
  .object({ password: passwordField, newPassword: passwordField })
  .catch({});
export type AuthRequestPasswords = z.infer<typeof authRequestPasswordsSchema>;

/**
 * Checks the password a Better Auth request would set. Returns `{ ok: true }`
 * for endpoints that set no password, and for `/admin/create-user` without a
 * password (a user with no credential account).
 */
export function validateAuthRequestPassword(
  path: string,
  body: AuthRequestPasswords,
): PasswordPolicyResult {
  const field = PASSWORD_FIELD_BY_AUTH_PATH[path];
  if (!field) return { ok: true };
  const value = body[field];
  if (path === '/admin/create-user' && value === undefined) return { ok: true };
  return validatePasswordStrength(value);
}
