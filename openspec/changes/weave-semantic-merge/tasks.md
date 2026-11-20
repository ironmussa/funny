# Weave Semantic Merge — Tasks

## ~~Task 1: Core Weave Functions~~ [x]

**File:** `packages/core/src/git/weave.ts` (new)

Create the core Weave integration module with two functions:

**`getWeaveStatus(projectPath)`**

- Check if `weave-driver` is on PATH (`which weave-driver`)
- Check if `merge.weave.driver` is set in local git config
- Check if `.git/info/attributes` contains `merge=weave` lines
- Return `WeaveStatus` object with `driverInstalled`, `driverConfigured`, `attributesConfigured`, and derived `status` field

**`ensureWeaveConfigured(projectPath)`**

- Bail with `not-installed` status if `weave-driver` not on PATH
- Run `git config --local merge.weave.name "Weave semantic merge driver"`
- Run `git config --local merge.weave.driver "weave-driver %O %A %B %L %P"`
- Ensure `.git/info/` directory exists
- Read existing `.git/info/attributes`, append `<ext> merge=weave` lines for all supported extensions (skip if already present)
- Return resulting `WeaveStatus`

Both functions use `ResultAsync` / `neverthrow` pattern. Use async process execution from existing `git-v2.ts` patterns.

Supported extensions: `*.ts *.tsx *.js *.jsx *.mjs *.cjs *.py *.go *.rs *.java *.c *.cpp *.h *.rb *.cs *.php *.swift *.json *.yaml *.yml *.toml *.md`

---

## ~~Task 2: Shared Types~~ [x]

**File:** `packages/shared/src/types.ts`

Add the `WeaveStatus` type:

```typescript
interface WeaveStatus {
  driverInstalled: boolean;
  driverConfigured: boolean;
  attributesConfigured: boolean;
  status: 'active' | 'unconfigured' | 'not-installed';
}
```

---

## ~~Task 3: Server Endpoints~~ [x]

**File:** `packages/runtime/src/routes/projects.ts`

Add two new routes:

**`GET /api/projects/:id/weave/status`**

- Validate project exists and belongs to user
- Call `getWeaveStatus(project.path)`
- Return the `WeaveStatus` object

**`POST /api/projects/:id/weave/configure`**

- Validate project exists and belongs to user
- Call `ensureWeaveConfigured(project.path)`
- Return `{ ok: true, status: WeaveStatus }`

---

## ~~Task 4: Auto-Configure on Project Creation~~ [x]

**File:** `packages/runtime/src/services/project-manager.ts`

In `createProject()`, after the project is successfully created:

- Call `ensureWeaveConfigured(project.path)` as fire-and-forget
- Do not block project creation on Weave setup
- Do not surface errors — if Weave isn't installed, nothing happens

---

## ~~Task 5: Client API Methods~~ [x]

**File:** `packages/client/src/lib/api.ts`

Add two methods:

```typescript
getWeaveStatus(projectId: string): Promise<WeaveStatus>
// GET /api/projects/{projectId}/weave/status

configureWeave(projectId: string): Promise<{ ok: boolean; status: WeaveStatus }>
// POST /api/projects/{projectId}/weave/configure
```

---

## ~~Task 6: Settings UI — WeaveStatusSetting Component~~ [x]

**File:** `packages/client/src/components/SettingsDetailView.tsx`

Add `WeaveStatusSetting` component to the General settings section, placed after `LauncherUrlSetting`.

**Props:** `{ projectId: string }`

**Behavior:**

- On mount, fetches `GET /api/projects/:id/weave/status`
- Shows loading skeleton while fetching
- Renders using existing `SettingRow` pattern

**Three render states:**

1. **active**: Green check + "Active" text + "Reconfigure" button
2. **unconfigured**: "Not configured" text + "Configure" button
3. **not-installed**: "weave-driver not found" text + link to `https://github.com/Ataraxy-Labs/weave`

**Configure/Reconfigure button:**

- Calls `POST /api/projects/:id/weave/configure`
- Shows loading spinner during request
- Refreshes status on completion
- Shows success/error toast

**data-testid attributes:**

- `settings-weave-status` on the status text
- `settings-weave-configure` on the configure/reconfigure button
- `settings-weave-install-link` on the install link
