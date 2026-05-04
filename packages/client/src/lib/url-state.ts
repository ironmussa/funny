// Single source of truth for the active org slug used by lib/url.ts to build
// path prefixes. auth-store pushes updates here on initialize and setActiveOrg
// so lib/url doesn't need to depend on auth-store directly.

let activeOrgSlug: string | null = null;

export function setActiveOrgSlug(slug: string | null): void {
  activeOrgSlug = slug;
}

export function getActiveOrgSlug(): string | null {
  return activeOrgSlug;
}
