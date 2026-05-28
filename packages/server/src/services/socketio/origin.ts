/**
 * Security ME-8 — pure predicate for the browser-namespace upgrade gate.
 */
export function isAllowedBrowserOrigin(origin: string | undefined, allowlist: string[]): boolean {
  if (!origin) return false;
  return allowlist.includes(origin);
}
