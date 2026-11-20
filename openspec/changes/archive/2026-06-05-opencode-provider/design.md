## Context

funny's agent layer is a registry of `IAgentProcess` implementations keyed by provider string (`process-factory.ts`). Four of the existing providers (codex, gemini, pi, cursor) are ACP adapters: each spawns a CLI over stdio, opens a JSON-RPC `ClientSideConnection` from `@agentclientprotocol/sdk`, and translates ACP `sessionUpdate` notifications into funny's internal `CLIMessage` stream. They all extend `BaseAgentProcess`, which owns the turn lock, steer/cancel, permission-pause, and result emission.

opencode ships native ACP via `opencode acp`, so it slots into this exact shape. The only structural decision is **which existing adapter to clone**, and opencode's multi-provider model routing makes **Cursor** the right template (both have dynamic, user-configured catalogs rather than a static model list).

## Goals / Non-Goals

**Goals**

- opencode selectable as a provider with the same UX as cursor (dynamic model list, native fork, multi-turn, steer, permission cards).
- Zero new infrastructure — reuse `BaseAgentProcess`, the shared ACP helpers, and the cursor-shaped discovery + client plumbing.
- Graceful degradation when opencode isn't installed or the user hasn't logged in.

**Non-Goals**

- No opencode _server/SDK_ (`opencode serve` + SSE) integration — ACP gives fork/resume/permissions for free; the HTTP path would re-implement all of it.
- No `PROVIDER_KEY_REGISTRY` entry — auth is pre-done on the runner (`opencode auth login`).
- No static model registry beyond the `default` sentinel — the catalog is discovered.

## Decisions

### Decision 1: ACP, not the opencode HTTP SDK

opencode exposes both `opencode acp` (ACP/stdio) and `opencode serve` (HTTP+SSE) + `@opencode-ai/sdk`. We use **ACP**.

- **Why:** funny's entire multi-turn/fork/permission/MCP machinery is ACP-shaped. Cloning `cursor-acp.ts` reuses it wholesale; the HTTP path would force a parallel translation layer (SSE→CLIMessage), a second fork strategy, and a second permission model — for the same result.
- **Trade-off:** we inherit whatever ACP capabilities opencode advertises (which may lag its native HTTP API). Acceptable: the adapter degrades by capability flag, exactly like codex/cursor already do.

### Decision 2: Clone Cursor, not Codex

Both cursor and opencode route to many backend models the user configures, so neither can carry a static catalog. Cursor already solved this with `cursor-discover.ts` (ACP probe → `models.availableModels`), a cached `/api/system/cursor/models` route, a client store, and `resolveModelId` passthrough for wire-format IDs. opencode mirrors all of it.

- Codex, by contrast, has a fixed model list and reasoning-effort fusion (`gpt-5.4/medium`) — machinery opencode doesn't need.

### Decision 3: Dynamic model discovery (full v1 scope)

`opencode-discover.ts` spawns `opencode acp`, runs `initialize` + `newSession`, and reads the advertised catalog. Cached 60s behind `/api/system/opencode/models`, consumed by a client store + hook + a group in the unified prompt picker.

- **SPIKE-CONFIRMED:** opencode's `session/new` response returns `models.availableModels: [{ modelId, name }]` + `models.currentModelId` — **byte-for-byte the same shape cursor advertises.** `cursor-discover.ts` is copied almost verbatim; no `opencode models` CLI fallback is needed.
- The `default` sentinel in `MODEL_REGISTRY.opencode` keeps the static type system happy and serves as the fallback label when discovery fails.
- **Effort is encoded as a model-id suffix** (`opencode/gpt-5-nano/low|medium|high`, `.../big-pickle/max`). opencode parses the suffix server-side (`session/set_model` returns `{ modelId, variant }`). funny therefore does NOT need a separate effort selector for opencode — the variants surface as discrete entries in `availableModels`. Leave opencode out of `PROVIDERS_WITH_EFFORT` (already the case).

### Decision 4: Auth pre-done on the runner

The user runs `opencode auth login` once on the runner host (opencode persists credentials to its own config dir). funny injects nothing and adds no Settings key.

- **Why:** opencode is multi-provider — a single funny-managed key can't cover its backends, and a per-backend key matrix duplicates opencode's own `auth` system. Same trust boundary and UX as cursor (`cursor-agent login`).
- Discovery maps the JSON-RPC auth error to `reason: 'auth_required'` so the UI can show "run `opencode auth login` on your runner" instead of an opaque failure (cursor already does this — reuse the mapping).

### Decision 5: Permission + mode mapping

opencode's ACP `requestPermission` is handled by the inherited `BaseAgentProcess` flow: consult persisted rules → otherwise emit a synthetic tool_use/tool_result pair (renders a PermissionApprovalCard) → pause until abort.

- **SPIKE-CONFIRMED:** opencode advertises exactly **two** session modes — `build` (default; executes tools per configured permissions) and `plan` (disallows edit tools). The mapping is therefore trivial: funny `plan` → opencode `plan`; everything else → opencode `build`, set via `session/set_mode` after `newSession`. There is no separate "bypass/full-access" mode — autonomy is governed by opencode's own permission config + the `requestPermission` round-trip.

### Decision 6: Model selection uses `session/set_model`, not cursor's method

**SPIKE-CONFIRMED:** opencode does NOT advertise `setSessionModel`/`unstable_setSessionModel` in `agentCapabilities`. Model selection is done by calling the **`session/set_model`** JSON-RPC method with the full suffixed `modelId` (`opencode/gpt-5-nano/low`); opencode echoes `_meta.opencode.{ modelId, variant }`. The adapter calls `session/set_model` after `newSession` instead of cursor's `unstable_setSessionModel`. (`session/select_model` does NOT exist — returns `-32601`.)

### Decision 7: Fork capability lives under `sessionCapabilities`

**SPIKE-CONFIRMED:** opencode advertises fork at `agentCapabilities.sessionCapabilities.fork` (object), whereas `acp-fork.ts` currently probes `agentCapabilities.sessions?.fork`. The fork helper must accept **both** shapes (`sessions?.fork ?? sessionCapabilities?.fork`) so opencode forks natively. opencode also advertises `loadSession: true`, `sessionCapabilities.{list,resume}`, `promptCapabilities.{image,embeddedContext}` — full resume + image support.

## Risks / Trade-offs

- ~~ACP capability lag~~ — **resolved by spike:** opencode advertises `loadSession`, `sessionCapabilities.fork`, `promptCapabilities.image`, and model discovery. The only non-standard bit is the model-set method name (Decision 6) and the fork capability path (Decision 7), both handled.
- **Live update-emission shapes unconfirmed** — the spike prompt returned 0 tokens (OpenCode Zen models need auth/credits to generate), so `agent_message_chunk` / `tool_call` / `agent_thought_chunk` / `plan` shapes weren't observed in flight. _Mitigation:_ low risk — these are standard ACP `session/update` notifications (envelope confirmed: `params.update.sessionUpdate`) that codex/cursor/gemini adapters already translate. Confirm reasoning/plan rendering with an authenticated model during task 2.4.
- **Cold-start latency** — `opencode acp` first-byte may exceed cursor's 15s discovery timeout. _Mitigation:_ tune `timeoutMs`; result is cached 60s.
- **Binary resolution on Windows** — handled by the existing `shell: process.platform === 'win32'` pattern + `OPENCODE_BIN` / `ACP_OPENCODE_BIN` / `OPENCODE_ACP_USE_NPX` env overrides mirrored from cursor.

## Migration Plan

Additive — no DB migration, no protocol version bump, no client breaking changes. Ship behind provider-availability detection: opencode only appears in the picker when the binary resolves on the runner. Rollback = remove the registry entry; existing providers are untouched.

## Open Questions

All four pre-implementation questions were resolved by the ACP spike (opencode 1.2.27); see Decisions 3/5/6/7 and Risks. The single residual — exact in-flight reasoning/plan update shapes — is deferred to task 2.4 (confirm with an authenticated model) and carries no design risk because the ACP update vocabulary is already handled by the existing adapters.
