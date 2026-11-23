# Design

## Context

- Every provider's messages and tool calls are stored in the server DB in one shape; the runner reads them through `RuntimeServiceProvider` over the data channel.
- `runtime/services/commit-message-generator.ts` already does a one-shot generation: Claude Agent SDK `query()` with `maxTurns: 1`, `tools: []`, a system prompt and a timeout via `runAsync`. It always uses the SDK's default model.
- `core/agents/llm/` has `ModelFactory.resolve(provider, model)` → `{ baseURL, apiKey, modelId }` and `AgentExecutor`, which calls `/chat/completions` (OpenAI-compatible) in an agent loop. Users' provider keys live encrypted in `user_profiles.provider_keys` and already reach the runner for LLM API threads.
- Read state is client-side: `client-core/stores/thread-read.ts` keeps `readAt[threadId]` in platform storage, so "last read" is per device.

## Goals / Non-Goals

**Goals:**

- One generation path for helper text, with the model chosen per user, used by recaps and commit messages.
- Recaps that cost nothing when nothing happened and at most one generation per (thread, newest message) per session.

**Non-Goals:**

- Persisting recaps on the server, or syncing read state across devices.
- Recaps for sandbox threads or for sharees.
- Moving thread titles to the utility model (no generated titles exist today; a later change can adopt it).
- Using the SDK's internal `awaySummaryEnabled` recap.

## Decisions

### D1. Generate on the owner's runner, not on the server

The default utility model is the Claude SDK, whose credentials (CLI login) live on the runner, and LLM API keys are already delivered there. The server only authorizes and proxies. New runtime route `POST /api/threads/:id/recap` with body `{ since: ISO, newestMessageId }`, reached through `middleware/proxy.ts` like other runner-proxied thread routes, owner-only (not on the steer allow-list), so the runner is certified with `withRunnerFor` for the owner. Sandbox threads are rejected by the client predicate and by the runtime (`400 recap-not-available-for-sandbox`), since their runner has no host credentials.
_Alternative:_ generate on the server with a deployment key. Rejected: it would bill the deployment for every user and need a new server-side credential.

### D2. Transcript built on the runner from stored rows

The runtime reads messages and tool calls after `since` through the existing provider, then compacts them (`recap-transcript.ts`, pure): assistant text, user messages, tool name + one-line input summary, a 300-character excerpt of tool output, the pending approval or question if any, and the thread's status. It keeps the newest entries within ~12k characters. Pure function, unit-tested per provider fixture.
_Alternative:_ the client sends the transcript. Rejected: larger request and the client only has the loaded page of messages.

### D3. `runUtilityGeneration` as the one dispatch point

`runtime/services/utility-model.ts` exports `runUtilityGeneration({ setting, system, prompt, signal, timeoutMs }): ResultAsync<string, UtilityModelError>`. Two backends:

- `claude-sdk`: the body extracted from `commit-message-generator.ts`, plus the `model` option (alias resolved via shared models).
- LLM API providers: a new `completeOnce()` in `core/agents/llm/complete.ts`: `ModelFactory.resolve` + one `POST /chat/completions`, no tools, returns `Result`. It reuses `AgentExecutor`'s request shape, not its loop.
  Errors: `utility-model-unavailable` (no credential / not logged in), `timeout`, `provider-error`. No fallback between providers (spec). Cancellation goes through `runAsync`'s signal into the SDK `abortController` / `fetch` signal.
  _Alternative:_ run the recap as a hidden `LLMApiProcess` agent. Rejected: an agent loop, events and a process per recap for a single completion.

### D4. Setting stored in `user_profiles.utility_model`

Nullable JSON column (migration), `UtilityModelSetting` zod schema in `@funny/shared/contracts/profile`, `null` meaning the default `{ provider: 'claude-sdk', model: 'haiku' }` (`resolveUtilityModel` in shared). Read and written through the `profile` tRPC port. The runtime reads it with the profile it already loads for git identity, so no new `data:*` type is needed; provider keys come from the same path LLM API threads use.

### D4b. On/off toggle in the profile, on by default

`user_profiles.thread_recap_enabled` (integer, `NOT NULL DEFAULT 1`, same migration as D4), exposed as `threadRecapEnabled: boolean` in the profile contract and saved through the `profile` port. Kept on the server rather than in the client `settings-store`, so it follows the user across devices like the utility model it sits next to. It is a display choice: the client stops asking, and the runtime does not re-check it (a recap request is owner-only already, so a direct call costs only the caller).
_Alternative:_ a local `settings-store` flag. Rejected: a user who turns it off would still get recaps on every other browser.

### D5. Client: query keyed by newest message, card in `ThreadView`

`data/thread-recap/` holds a query keyed `[threadId, newestMessageId]`, `staleTime: Infinity`, enabled only when the profile's `threadRecapEnabled` is true, `canShowRecap(thread)` (owner, not sandbox; in `lib/thread-variant.ts`) and the 5-minute / new-activity rule holds. `since` is the `readAt` value captured when the thread is opened, before the view marks it read. Dismissals live in `ui-store` keyed by `threadId:newestMessageId`. The card renders the recap as plain text (no markdown, no links), with a dismiss button (`thread-recap-dismiss`) and a loading skeleton. A `utility-model-unavailable` error shows one hint per session linking to Settings > Profile.

## Risks / Trade-offs

- [Prompt injection from tool output steers the recap text] → no tools, single turn, rendered as plain text, short excerpts only; at worst the recap is misleading, never an action.
- [Cost: a generation on every return] → only after 5 minutes away and new activity, cached per newest message, cheap default model, 30 s timeout.
- [Per-device read state regenerates the recap on a second device] → accepted for v1; it is one cheap call.
- [Commit messages change model for users who set a utility model] → intended; the default keeps today's behavior apart from pinning Haiku instead of the SDK default model. Call this out in the release notes.
- [A runner from before this change gets the recap route] → the proxy gets 404, the client treats it as a quiet failure.

## Migration Plan

Add the nullable `utility_model` column and `thread_recap_enabled INTEGER NOT NULL DEFAULT 1` in `db/migrate.ts` (SQLite and PG), so existing users start with recaps on. Deploy server and runner together; an old runner only means no recaps. Rollback: drop the client card; the column can stay.
