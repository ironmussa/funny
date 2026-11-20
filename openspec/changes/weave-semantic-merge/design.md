# Weave Semantic Merge — Design

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     WEAVE INTEGRATION                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Client                    Server                    Git Repo    │
│  ──────                    ──────                    ────────    │
│                                                                  │
│  Project Settings          POST /projects/:id/                   │
│  ┌──────────────────┐      weave/configure                       │
│  │ Semantic Merge    │─────►│                                    │
│  │ [Configure]       │      ├─ which weave-driver                │
│  └──────────────────┘      ├─ git config --local ──────► .git/  │
│                             │   merge.weave.driver        config │
│  GET /projects/:id/        ├─ write ──────────────► .git/info/  │
│  weave/status              │   attributes              attributes│
│  ┌──────────────────┐      └─ return status                      │
│  │ Status: ✓ Active  │◄────                                      │
│  └──────────────────┘                                            │
│                                                                  │
│  ─── Meanwhile, on merge ───────────────────────────────────    │
│                                                                  │
│  mergeBranch()             git rebase / git merge                │
│  (ZERO changes) ──────────►│                                    │
│                             ├─ Git sees *.ts merge=weave         │
│                             ├─ Git invokes weave-driver          │
│                             └─ Entity-level merge happens        │
│                                transparently                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Component 1: Core Weave Configuration (`packages/core`)

New file: `packages/core/src/git/weave.ts`

### Constants

```typescript
const WEAVE_DRIVER_NAME = 'weave';
const WEAVE_DRIVER_CMD = 'weave-driver %O %A %B %L %P';
const WEAVE_EXTENSIONS = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
  '*.py',
  '*.go',
  '*.rs',
  '*.java',
  '*.c',
  '*.cpp',
  '*.h',
  '*.rb',
  '*.cs',
  '*.php',
  '*.swift',
  '*.json',
  '*.yaml',
  '*.yml',
  '*.toml',
  '*.md',
];
```

### `getWeaveStatus(projectPath): ResultAsync<WeaveStatus, DomainError>`

Checks three things and returns a status object:

```typescript
type WeaveStatus = {
  driverInstalled: boolean; // weave-driver found on PATH
  driverConfigured: boolean; // merge.weave.driver set in local git config
  attributesConfigured: boolean; // .git/info/attributes has merge=weave lines
  status: 'active' | 'unconfigured' | 'not-installed';
};
```

**Steps:**

1. Run `which weave-driver` (or `command -v weave-driver`) — sets `driverInstalled`
2. Run `git config --local --get merge.weave.driver` in projectPath — sets `driverConfigured`
3. Read `.git/info/attributes` file, check for `merge=weave` lines — sets `attributesConfigured`
4. Derive `status`:
   - `not-installed` if `!driverInstalled`
   - `unconfigured` if `driverInstalled && (!driverConfigured || !attributesConfigured)`
   - `active` if all three are true

### `ensureWeaveConfigured(projectPath): ResultAsync<WeaveStatus, DomainError>`

Idempotent setup. Returns the resulting status.

**Steps:**

1. Check `which weave-driver` — if not found, return `{ status: 'not-installed', ... }`
2. Set git config:
   ```
   git config --local merge.weave.name "Weave semantic merge driver"
   git config --local merge.weave.driver "weave-driver %O %A %B %L %P"
   ```
3. Ensure `.git/info/` directory exists (`mkdir -p`)
4. Read existing `.git/info/attributes` (if any)
5. For each extension in `WEAVE_EXTENSIONS`, if the line `<ext> merge=weave` is not already present, append it
6. Write back `.git/info/attributes`
7. Return `getWeaveStatus()` to confirm

### Error Handling

- Uses `ResultAsync` / `neverthrow` pattern consistent with the rest of `packages/core/src/git/`
- All failures are non-fatal — caller decides what to do
- `ensureWeaveConfigured` failing during `createProject` should not block project creation

## Component 2: Server Endpoints (`packages/server`)

### Route: `GET /api/projects/:id/weave/status`

```typescript
// Response
{
  driverInstalled: boolean;
  driverConfigured: boolean;
  attributesConfigured: boolean;
  status: 'active' | 'unconfigured' | 'not-installed';
}
```

1. Look up project by ID (validate ownership)
2. Call `getWeaveStatus(project.path)`
3. Return result

### Route: `POST /api/projects/:id/weave/configure`

```typescript
// Response
{
  ok: true;
  status: WeaveStatus;
}
```

1. Look up project by ID (validate ownership)
2. Call `ensureWeaveConfigured(project.path)`
3. Return result

### Auto-configure on project creation

In `createProject()` (project-manager.ts), after the project is created and returned:

```
// Fire-and-forget — don't block project creation on Weave setup
ensureWeaveConfigured(project.path).then(() => {}).catch(() => {});
```

This is intentionally non-blocking. If Weave isn't installed, nothing happens. If it fails, the user can configure later via settings.

## Component 3: Client Settings UI (`packages/client`)

### Location in Settings

Added to the General settings section in `SettingsDetailView.tsx`, after `LauncherUrlSetting` and before the permissions section.

### WeaveStatusSetting Component

New component, defined inline in `SettingsDetailView.tsx` (same pattern as `LauncherUrlSetting`):

```
Props: { projectId: string }
State: { status: WeaveStatus | null, loading: boolean, configuring: boolean }
```

**On mount:** calls `GET /api/projects/:id/weave/status`

**Renders three states:**

```
STATE 1: active
┌────────────────────────────────────────────────────────┐
│  Semantic Merge (Weave)                                │
│  Reduces false merge conflicts using semantic analysis │
│                                                        │
│  ✓ Active                           [Reconfigure]      │
└────────────────────────────────────────────────────────┘

STATE 2: unconfigured (driver installed but not set up)
┌────────────────────────────────────────────────────────┐
│  Semantic Merge (Weave)                                │
│  Reduces false merge conflicts using semantic analysis │
│                                                        │
│  ○ Not configured                   [Configure]        │
└────────────────────────────────────────────────────────┘

STATE 3: not-installed
┌────────────────────────────────────────────────────────┐
│  Semantic Merge (Weave)                                │
│  Reduces false merge conflicts using semantic analysis │
│                                                        │
│  weave-driver not found                                │
│  Install → github.com/Ataraxy-Labs/weave               │
└────────────────────────────────────────────────────────┘
```

**Configure button:** calls `POST /api/projects/:id/weave/configure`, shows loading spinner, refreshes status on completion, shows success/error toast.

### API Client Methods

In `packages/client/src/lib/api.ts`:

```typescript
getWeaveStatus(projectId: string): Promise<WeaveStatus>
// GET /api/projects/{projectId}/weave/status

configureWeave(projectId: string): Promise<{ ok: boolean; status: WeaveStatus }>
// POST /api/projects/{projectId}/weave/configure
```

## File Layout

```
packages/
├── core/src/git/
│   └── weave.ts              ← NEW: ensureWeaveConfigured, getWeaveStatus
├── server/src/
│   ├── routes/projects.ts    ← MODIFY: add weave/status and weave/configure routes
│   └── services/
│       └── project-manager.ts ← MODIFY: call ensureWeaveConfigured in createProject
├── client/src/
│   ├── components/
│   │   └── SettingsDetailView.tsx  ← MODIFY: add WeaveStatusSetting component
│   └── lib/
│       └── api.ts            ← MODIFY: add getWeaveStatus, configureWeave methods
└── shared/src/
    └── types.ts              ← MODIFY: add WeaveStatus type
```

## What Does NOT Change

- `packages/core/src/git/git.ts` — `mergeBranch()` is untouched
- `packages/runtime/src/services/git-service.ts` — merge service is untouched
- `packages/runtime/src/services/git-pipelines.ts` — merge pipeline is untouched
- `packages/client/src/components/ReviewPane.tsx` — merge UI is untouched
- No database schema changes
- No new dependencies
