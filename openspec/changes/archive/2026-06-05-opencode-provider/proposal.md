## Why

funny already orchestrates five agent backends through one provider abstraction: Claude (SDK), Codex, Gemini, Pi, and Cursor — the last four over the Agent Client Protocol (ACP). [opencode](https://opencode.ai) (sst/opencode) is a popular open-source terminal coding agent that ships **native ACP support** via `opencode acp` (JSON-RPC over stdio) and is already listed in [Zed's ACP Registry](https://zed.dev/acp/agent/opencode) alongside Claude Code and Codex.

Because opencode speaks the exact protocol funny's ACP adapters already use, adding it is a _replication_ of the existing pattern — not new infrastructure. opencode also routes to many underlying model providers (configured by the user), which makes it structurally identical to **Cursor**: a dynamic, user-configured model catalog rather than a static list. Cursor is therefore the template to mirror end-to-end.

## What Changes

- Add `'opencode'` as a first-class `AgentProvider` across the shared type contract, core agent factory, runtime detection/discovery, and client model picker.
- New ACP adapter `OpenCodeACPProcess` (modeled on `CursorACPProcess`) that spawns `opencode acp`, translates ACP `sessionUpdate` events into `CLIMessage`, and reuses the shared ACP helpers (`acp-tool-input`, `acp-image`, `acp-mcp`) and `BaseAgentProcess` lifecycle (multi-turn, steer/cancel, permission pause).
- **Dynamic model discovery** (chosen scope): `opencode-discover.ts` spawns `opencode acp` once, reads the advertised model catalog from the `newSession` response (with `opencode models` CLI as a fallback probe), exposed via `/api/system/opencode/models`. Client gets a models store + hook + unified-picker group, mirroring Cursor.
- **Auth = pre-auth on runner** (chosen scope): the user runs `opencode auth login` once on the runner; funny injects no opencode credentials and adds no `PROVIDER_KEY_REGISTRY` entry. Same trust boundary as Cursor. Discovery surfaces an `auth_required` state when the user hasn't logged in.
- Out-of-process session fork support: add `'opencode'` to `acp-fork.ts` so opencode threads branch natively like codex/gemini/pi/cursor.
- Provider availability detection so the Settings UI exposes opencode only when the binary is present (or `npx`-reachable).

## Capabilities

### New Capabilities

- `opencode-provider`: Run opencode as a selectable agent backend in funny over ACP, with dynamically discovered models, native session fork/resume, and runner-side authentication.

### Modified Capabilities

<!-- No existing capability specs to modify — provider abstraction is extended, not changed. -->

## Impact

**Shared (`packages/shared/src`)**

- `primitives.ts` — add `'opencode'` to the `AgentProvider` union.
- `models.ts` — add `opencodeModels` (`default` sentinel like cursor/pi), wire into `MODEL_REGISTRY`, `PROVIDER_LABELS`, `PROVIDER_DEFAULT_MODEL`, `PROVIDER_ATTACHMENT_LIMITS`, `getDefaultAllowedTools`, and the derived model-type union. `resolveModelId` passthrough for dynamic IDs (same branch as pi/cursor).
- `runner-protocol.ts` — provider passthrough (string union widening only).

**Core (`packages/core/src/agents`)**

- `opencode-acp.ts` — **NEW** adapter (≈ cursor-acp.ts, trimmed for opencode quirks).
- `opencode-discover.ts` — **NEW** dynamic catalog probe (≈ cursor-discover.ts).
- `process-factory.ts` — register `['opencode', OpenCodeACPProcess]`.
- `acp-fork.ts` — add `'opencode'` to `AcpProvider` + `resolveAcpCommand`.
- `index.ts` — export the new adapter + discovery fn.
- `acp-tool-input.ts` — only if opencode emits non-standard tool kinds (per the ACP-layering rule: standard behavior stays in the shared builder; only true quirks go in the adapter).

**Runtime (`packages/runtime/src`)**

- `utils/provider-detection.ts` — `checkOpenCodeAvailability()` + register in `getAvailableProviders`.
- `app/system-routes.ts` — `GET /api/system/opencode/models` (cached, mirrors cursor route).
- `validation/schemas.ts` — add `'opencode'` to the provider enum + dynamic-model passthrough.
- `services/thread-service/fork.ts` — include opencode in the native-fork branch.

**Client (`packages/client/src`)**

- `lib/providers.ts` — auto-derives from `MODEL_REGISTRY` (no change beyond the registry).
- `stores/opencode-models-store.ts` — **NEW** (≈ cursor-models-store).
- `hooks/use-opencode-prompt-models.ts` — **NEW** (≈ use-cursor-prompt-models).
- `hooks/use-unified-prompt-model-groups.ts` — merge the opencode group.
- `lib/api/system.ts` — fetch helper for the new endpoint.
- `components/GeneralSettings.tsx` — surface opencode availability + login hint.
- i18n — model labels under `thread.model.*`.

**Tests**

- `__tests__/opencode-acp.test.ts` (≈ cursor-acp.test.ts), `process-factory.test.ts` (+case), `acp-fork.test.ts` (+case).

**No DB migration, no protocol change, no breaking changes.** The provider abstraction is additive.
