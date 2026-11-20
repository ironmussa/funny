## 0. Spike — confirm opencode's ACP surface (DONE — opencode 1.2.27, 2026-06-05)

- [x] 0.1 `initialize` capabilities: `loadSession: true`, `sessionCapabilities.{fork,list,resume}`, `promptCapabilities.{image,embeddedContext}`. NOTE: NO `setSessionModel` flag; fork is under `sessionCapabilities.fork` (not `sessions.fork`)
- [x] 0.2 `session/new` returns `models.availableModels: [{ modelId, name }]` + `currentModelId` — identical shape to cursor. No CLI fallback needed
- [x] 0.3 N/A — ACP advertises models, `opencode models` fallback not required
- [x] 0.4 Modes: only `build` (default) + `plan` (no edits). Model selection = **`session/set_model`** (echoes `{ modelId, variant }`); effort is a modelId suffix (`/low|medium|high|max`). In-flight reasoning/plan shapes deferred to 2.4 (test prompt returned 0 tokens — Zen models need credits)
- [x] 0.5 `authMethods: [{ id: 'opencode-login', description: 'Run opencode auth login' }]` — confirms pre-auth on runner

## 1. Shared type contract (`packages/shared/src`)

- [x] 1.1 `primitives.ts` — add `'opencode'` to the `AgentProvider` union
- [x] 1.2 `models.ts` — add `opencodeModels = { default: {...} }` sentinel
- [x] 1.3 `models.ts` — wire opencode into `MODEL_REGISTRY`, `PROVIDER_LABELS`, `PROVIDER_DEFAULT_MODEL`, `PROVIDER_ATTACHMENT_LIMITS`, derived type union
- [x] 1.4 `models.ts` — `getDefaultAllowedTools` returns `[]` for opencode (manages its own tools via ACP); `resolveModelId` passthrough for dynamic IDs (extend the pi/cursor branch)
- [x] 1.5 `models.ts` — `resolvePermissionMode` returns `undefined` for opencode (mode set in-adapter via `session/set_mode`, like codex/gemini); `resolveResumePermissionMode` no-op (claude-only)
- [x] 1.6 Verify shared types + model tests: `bunx tsc` clean for models.ts/primitives.ts; `bun test models.test.ts` → 83 pass

## 2. Core ACP adapter (`packages/core/src/agents`)

- [x] 2.1 Create `opencode-acp.ts` — `OpenCodeACPProcess extends BaseAgentProcess`, modeled on `cursor-acp.ts`
- [x] 2.2 Implement `resolveOpenCodeAcpCommand()` — `opencode acp` with `OPENCODE_BIN` / `ACP_OPENCODE_BIN` / `OPENCODE_ACP_USE_NPX` overrides
- [x] 2.3 Wire `initialize` → capability probe (`loadSession`, `promptCapabilities.image`) → `loadSession`-or-`newSession` → `emitInit`. Set mode via `setSessionMode` (funny `plan` → `plan`, else → `build`), fresh sessions only
- [x] 2.4 Implement `translateUpdate` reusing `acp-tool-input`/`acp-image`/`acp-mcp` (cloned cursor's robust deferred-tool-input logic). NOTE: in-flight reasoning/plan shapes still to be visually confirmed against an **authenticated** opencode model during manual verify (6.4)
- [x] 2.5 Wire `sendPrompt` (multi-turn) + `getCancellableSession` (steer/cancel) + model selection via **`session/set_model`** through the SDK's `extMethod` escape hatch (opencode doesn't advertise `setSessionModel`; spike-confirmed raw method works)
- [x] 2.6 Register `['opencode', OpenCodeACPProcess]` in `process-factory.ts`
- [x] 2.7 `acp-fork.ts` — added `'opencode'` to `AcpProvider` + `resolveAcpCommand`; widened fork-capability probe to accept `sessionCapabilities.fork` as well as `sessions.fork`
- [x] 2.8 `index.ts` — export adapter + discovery fn

## 3. Core dynamic discovery (`packages/core/src/agents`)

- [x] 3.1 Create `opencode-discover.ts` — near-verbatim copy of `cursor-discover.ts` (spike confirmed identical `models.availableModels: [{ modelId, name }]` + `currentModelId` shape): spawn `opencode acp`, `initialize` + `newSession`, read catalog → `{ ok, models, currentModelId } | { ok:false, reason }`
- [x] 3.2 Map the not-logged-in JSON-RPC error → `reason: 'auth_required'` with "run `opencode auth login` on your runner"
- [x] 3.3 Unit test discovery result mapping (`opencode-discover.test.ts`, mock spawn) — covers `ok`, `auth_required`, `agent_error`, `timeout`, `no_models`, env override

## 4. Runtime (`packages/runtime/src`)

- [~] 4.1 `utils/provider-detection.ts` — **SKIPPED by design**: `provider-detection` only detects claude+codex; cursor/gemini/pi are NOT there and surface via the registry + their discovery endpoint's `auth_required` state. opencode follows the same pattern (registry + `/system/opencode/models`), so adding it here alone would be inconsistent. No code change.
- [x] 4.2 `app/system-routes.ts` — `GET /api/system/opencode/models` (60s cache, mirrors cursor route)
- [x] 4.3 `validation/schemas.ts` — add `'opencode'` to provider enum + `opencodeModelSchema` (dynamic) + union + `validateProviderModel` passthrough
- [x] 4.4 `services/thread-service/fork.ts` — added opencode to `ACP_PROVIDERS` + widened the `forkAcpSession` provider cast
- [x] 4.5 Verify runtime build: `bun run --cwd packages/runtime build` → clean

## 5. Client (`packages/client/src`)

- [x] 5.1 `stores/opencode-models-store.ts` — **NEW** (≈ cursor-models-store)
- [x] 5.2 `hooks/use-opencode-prompt-models.ts` — **NEW** (≈ use-cursor-prompt-models)
- [x] 5.3 `lib/api/system.ts` — `OpenCodeModelEntry`/`OpenCodeModelsResponse` types + `getOpenCodeModels` helper
- [x] 5.4 `hooks/use-unified-prompt-model-groups.ts` — merge the opencode group into the picker
- [x] 5.5 `components/GeneralSettings.tsx` — fetch opencode catalog + merge into project default-model combobox (login hint surfaced via the picker's `auth_required` group label)
- [x] 5.6 i18n — `thread.model.opencodeDefault` added to en/es/pt; error/loading hints keep inline fallbacks (mirrors cursor)
- [x] 5.7 No new interactive elements — opencode flows through the existing model picker which already carries `data-testid`s
- [x] 5.8 Verify client build: `tsc -b` clean + `vite build` → built in 3.69s

## 6. Tests & verification

- [x] 6.1 `__tests__/opencode-acp.test.ts` — focused adapter translation tests (text streaming, tool_call+result, thought→Think, plan→TodoWrite, usage)
- [x] 6.2 `process-factory.test.ts` — opencode routes to `OpenCodeACPProcess`
- [x] 6.3 `acp-fork.test.ts` — opencode fork command + the new `sessionCapabilities.fork` shape + env overrides
- [~] 6.4 Manual: full thread end-to-end through the funny UI (message, tool call, permission card, follow-up, steer) — **deferred to manual run** (requires the app + an authenticated generating model; not runnable headlessly under the no-dev-server rule)
- [x] 6.5 Live discovery verified against the real `opencode acp` binary out-of-band — parsed 14 models + `currentModelId` (route→core→ACP path proven). UI `auth_required` hint wired via the picker group label.
- [x] 6.6 Type-checks clean: core `tsc --noEmit` 0 errors; runtime `build` clean; client `tsc -b` + `vite build` clean; shared model tests green
