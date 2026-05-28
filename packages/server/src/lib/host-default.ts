/**
 * Security CR-7 — server HOST default.
 *
 * Default to loopback so a fresh install isn't reachable from the LAN /
 * internet before the operator changes the auto-generated admin password.
 * Operators who want remote exposure must set HOST=0.0.0.0 (or another
 * address) explicitly.
 */
export function resolveHost(envValue: string | undefined): string {
  if (typeof envValue !== 'string' || envValue.length === 0) return '127.0.0.1';
  return envValue;
}
