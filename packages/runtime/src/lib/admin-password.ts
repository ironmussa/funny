/**
 * Security CR-7 — runtime admin password resolution.
 *
 * Replaces the previous `const password = 'admin'` hardcoded literal with
 * a policy-driven choice:
 *   - If `ADMIN_PASSWORD` env is set and ≥10 characters, use it as-is.
 *   - Otherwise generate a cryptographically random password via the
 *     caller-supplied `generate` thunk (defaults `randomBytes(16).toString
 *     ('base64url')` at the call site).
 *
 * Pure function — no FS or env access here so the test surface is just
 * "given input X, return output Y".
 */
export interface ResolvedAdminPassword {
  /** The password to seed the admin account with. */
  password: string;
  /** True when the password was generated (caller writes it to a 0600 file). */
  isGenerated: boolean;
  /** Optional warning message the caller should log if non-empty. */
  warning: string | null;
}

export function resolveAdminPassword(
  envValue: string | undefined,
  generate: () => string,
): ResolvedAdminPassword {
  if (typeof envValue === 'string' && envValue.length >= 10) {
    return { password: envValue, isGenerated: false, warning: null };
  }
  const warning =
    typeof envValue === 'string' && envValue.length > 0
      ? 'ADMIN_PASSWORD env did not meet minimum length (>=10 chars) — falling back to a generated password'
      : null;
  return { password: generate(), isGenerated: true, warning };
}
