import { useAuthStore } from '@/stores/auth-store';

/** Known top-level route segments that are NOT org slugs. */
const STATIC_ROUTES = new Set([
  'projects',
  'settings',
  'preferences',
  'inbox',
  'list',
  'kanban',
  'analytics',
  'grid',
  'new',
  'invite',
]);

/** Build an app-internal path, auto-prefixing the active org slug if any. */
export function buildPath(path: string): string {
  const slug = useAuthStore.getState().activeOrgSlug;
  if (!slug) return path;
  // Avoid double-prefixing
  if (path.startsWith(`/${slug}/`) || path === `/${slug}`) return path;
  return `/${slug}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Strip the org slug prefix from a pathname.
 * Returns [orgSlug | null, cleanPath].
 *
 * If the first segment is a known static route, it's NOT an org slug.
 * Otherwise, it's treated as an org slug and stripped.
 */
export function stripOrgPrefix(pathname: string): [string | null, string] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [null, '/'];

  const potentialSlug = segments[0];
  if (STATIC_ROUTES.has(potentialSlug)) return [null, pathname];

  const rest = '/' + segments.slice(1).join('/');
  return [potentialSlug, rest || '/'];
}
