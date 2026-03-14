# Plan: Org-Scoped URL Routing for Deep Linking

## Goal
When a user is in an organization, URLs should include the org slug as a prefix (`/:orgSlug/...`) to enable deep linking. Personal mode URLs stay unchanged (no prefix).

**URL Examples:**
- Personal: `/projects/123`, `/list`, `/settings/general`, `/preferences/theme`
- Organization: `/acme/projects/123`, `/acme/list`, `/acme/settings/general`, `/acme/preferences/theme`
- Deep link to org: navigating to `/acme/projects/123` auto-switches to the "acme" org

## Architecture Decision

The routing system uses **React Router** (`BrowserRouter`, `<Routes>`, `<Route>`, `useNavigate`, `useLocation`) but follows a **hybrid pattern**: React Router handles URL infrastructure, while most view selection is state-driven via Zustand stores (`selectedProjectId`, `selectedThreadId`, `activeSetting`). The `use-route-sync.ts` hook bridges the two by parsing URLs and syncing them to store state. The key insight is:

1. **`parseRoute()`** is the single entry point for URL → store sync
2. **`navigate()` calls** are scattered across ~20 files for store → URL
3. **`OrgSwitcher`** handles org switching via Better Auth + state reload

### Strategy: Centralized URL helpers + minimal changes to existing code

Rather than modifying every `navigate()` call individually, we'll create a **URL builder utility** that automatically prefixes the org slug, and modify `parseRoute()` to strip it.

---

## Implementation Steps

### Step 1: Add `activeOrgSlug` to auth-store

**File:** `packages/client/src/stores/auth-store.ts`

- Add `activeOrgSlug: string | null` to `AuthState`
- Update `setActiveOrg` signature to accept slug: `setActiveOrg(id, name, slug)`
- Clear `activeOrgSlug` on logout

### Step 2: Store slug in OrgSwitcher

**File:** `packages/client/src/components/OrgSwitcher.tsx`

- Pass `orgInfo?.slug` to `setActiveOrg()` calls
- The slug is already available in the org list data (`org.slug`)

### Step 3: Create URL helper utility

**File:** `packages/client/src/lib/url.ts` (new file)

```typescript
import { useAuthStore } from '@/stores/auth-store';

/** Build an app-internal path, auto-prefixing the active org slug if any. */
export function buildPath(path: string): string {
  const slug = useAuthStore.getState().activeOrgSlug;
  if (!slug) return path;
  if (path.startsWith(`/${slug}/`) || path === `/${slug}`) return path;
  return `/${slug}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Strip the org slug prefix from a pathname, returning [orgSlug | null, cleanPath]. */
export function stripOrgPrefix(pathname: string): [string | null, string] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [null, '/'];

  const potentialSlug = segments[0];
  const staticRoutes = new Set([
    'projects', 'settings', 'preferences', 'inbox', 'list',
    'kanban', 'analytics', 'grid', 'new', 'invite'
  ]);

  if (staticRoutes.has(potentialSlug)) return [null, pathname];

  const rest = '/' + segments.slice(1).join('/');
  return [potentialSlug, rest || '/'];
}
```

### Step 4: Update `parseRoute()` in use-route-sync.ts

**File:** `packages/client/src/hooks/use-route-sync.ts`

- Import `stripOrgPrefix` from `@/lib/url`
- At the top of `parseRoute()`, call `stripOrgPrefix(pathname)` to get `[orgSlug, cleanPath]`
- Use `cleanPath` for all existing `matchPath()` calls (zero changes to pattern matching)
- Return `orgSlug` as part of the result object

### Step 5: Add auto-switch logic in useRouteSync

**File:** `packages/client/src/hooks/use-route-sync.ts`

In the `useEffect`, after calling `parseRoute()`:
- If `orgSlug` is non-null and differs from `activeOrgSlug`:
  1. Look up the org by slug (fetch org list from Better Auth if not cached)
  2. Call `authClient.organization.setActive({ organizationId })`
  3. Update auth store with new org info
  4. Reload projects
- If `orgSlug` is null and `activeOrgSlug` is non-null → switch to personal mode
- If slug doesn't match any known org → redirect to `/` with error toast

### Step 6: Create `useOrgNavigate()` hook

**File:** `packages/client/src/hooks/use-org-navigate.ts` (new file)

A drop-in replacement for `useNavigate()` that wraps paths with `buildPath()`.

### Step 7: Update navigate() calls across all components

Replace `navigate('/path')` with `navigate(buildPath('/path'))` or switch to `useOrgNavigate()`:

1. `Sidebar.tsx` — all navigate calls
2. `sidebar/ProjectItem.tsx`
3. `sidebar/RunningThreads.tsx`
4. `sidebar/RecentThreads.tsx`
5. `CommandPalette.tsx`
6. `AllThreadsView.tsx`
7. `AutomationInboxView.tsx`
8. `ProjectHeader.tsx`
9. `KanbanView.tsx`
10. `AddProjectView.tsx`
11. `CloneRepoView.tsx`
12. `NewThreadInput.tsx`
13. `SettingsPanel.tsx`
14. `GeneralSettingsView.tsx`
15. `hooks/use-global-shortcuts.ts`
16. `stores/thread-ws-handlers.ts` (uses `appNavigate`)
17. `stores/thread-store-internals.ts` (stores navigate ref)

### Step 8: Update OrgSwitcher to navigate on switch

**File:** `packages/client/src/components/OrgSwitcher.tsx`

When switching orgs:
- `handleSwitch(orgId)` → navigate to `/${org.slug}/`
- `handleSwitchToPersonal()` → navigate to `/`

### Step 9: Edge cases

1. **Invalid org slug** → redirect to `/` with error toast
2. **Org slug conflicts with static routes** → blocked by `staticRoutes` set; server should also validate slug names at creation time
3. **Browser back/forward** → already handled by `useRouteSync` listening to `location.pathname`

---

## Files Summary

| File | Change |
|------|--------|
| `stores/auth-store.ts` | Add `activeOrgSlug` field |
| `lib/url.ts` | **NEW** — `buildPath()` + `stripOrgPrefix()` |
| `hooks/use-org-navigate.ts` | **NEW** — `useOrgNavigate()` hook |
| `hooks/use-route-sync.ts` | Strip org prefix in parseRoute, auto-switch org |
| `components/OrgSwitcher.tsx` | Pass slug, navigate on switch |
| ~17 component/store files | Wrap navigate paths with `buildPath()` |

## Order
1. auth-store → 2. url.ts → 3. use-route-sync.ts → 4. OrgSwitcher → 5. use-org-navigate.ts → 6. All navigate calls → 7. Edge cases → 8. Build verification
