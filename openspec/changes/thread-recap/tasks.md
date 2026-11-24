# Tasks

## 1. Utility model setting (shared + server)

- [x] 1.1 Add `UtilityModelSetting` zod schema (provider enum, model, optional baseURL required for `openai-compatible`) and `resolveUtilityModel(setting | null)` returning the `claude-sdk` / `haiku` default to `@funny/shared` (profile contract); verify with unit tests for the default, a valid OpenAI setting and the refused `openai-compatible` without base URL
- [x] 1.2 Add the nullable `user_profiles.utility_model` JSON column and `thread_recap_enabled INTEGER NOT NULL DEFAULT 1` to both schemas and `db/migrate.ts`; verify the migration test creates them on SQLite and PG and that an existing user's row reads `thread_recap_enabled = 1`
- [x] 1.3 Read and write `utilityModel` and `threadRecapEnabled` (integer ↔ boolean) through the `profile` tRPC port (invalid input → 400); verify with a port test covering save, read-back, the default `true` and the refused invalid save

## 2. One-shot generation backends (core + runtime)

- [x] 2.1 Add `completeOnce()` in `core/agents/llm/complete.ts` (`ModelFactory.resolve` + one `/chat/completions` POST, no tools, abort signal, returns `ResultAsync`); verify with a test against a stub HTTP server: success, provider error, abort
- [x] 2.2 Create `runtime/services/utility-model.ts` with `runUtilityGeneration`: `claude-sdk` backend extracted from `commit-message-generator.ts` plus the `model` option, LLM API backend via `completeOnce` with the user's provider key; map missing credentials to `utility-model-unavailable` with no fallback; verify with unit tests per backend, the unavailable error and timeout cancellation
- [x] 2.3 Route `generateCommitMessage` through `runUtilityGeneration` with the requesting user's setting; verify `commit-message-generator.test.ts` still passes and a new case asserts a non-default setting reaches the LLM API backend

## 3. Recap generation (runtime + server proxy)

- [x] 3.1 Implement pure `recap-transcript.ts` (entries after `since`, tool name + input summary, 300-char output excerpts, pending approval/question, status, newest kept within ~12k chars); verify with fixtures from a Claude, a Codex and an LLM API thread plus a truncation case
- [x] 3.2 Add `recap-generator.ts` (system prompt: at most three sentences in the given language, what was done / state / waiting on user; 30 s timeout) and the runtime route `POST /api/threads/:id/recap` (`{ since, newestMessageId, language }`), rejecting sandbox threads with `400 recap-not-available-for-sandbox`; verify with a route test using a stubbed `runUtilityGeneration`
- [x] 3.3 Make the recap route owner-only in `middleware/proxy.ts` (not on the steer allow-list, runner certified for the owner); verify a server test that a sharee and a stranger get 404 and no runner request is sent, and that the owner's request reaches only the owner's runner
- [x] 3.4 Document the recap route and utility model in `openwiki/` (agent-execution page) and add a short CLAUDE.md note pointing to `runUtilityGeneration` as the single path for helper generations; verify `bun run lint` (docs fitness checks) passes

## 4. Client

- [ ] 4.1 Add `canShowRecap(thread)` (owner, not sandbox) to `lib/thread-variant.ts` and `shouldOfferRecap(readAt, newestActivityAt, now)` (5-minute + new-activity rule, unread-ever = creation time); verify with unit tests for each spec scenario
- [ ] 4.2 Add `data/thread-recap/` (api via `requestInThread`, query keyed `[threadId, newestMessageId]`, `staleTime: Infinity`, enabled only when the profile's `threadRecapEnabled` is true, `hooks.ts`), capturing `since` from `readAt` before the thread is marked read; verify a test that reopening with no new activity makes no second request and that with recaps off no request is made
- [ ] 4.3 Build `ThreadRecapCard` (shadcn components, plain text, skeleton, `thread-recap-card` / `thread-recap-dismiss` test ids, dismissals in `ui-store`, one-time utility-model hint) and mount it in `ThreadView`; add en/es/pt strings; verify component tests for shown / dismissed / quiet failure / hint and `fitness:client-styling` passes
- [ ] 4.4 Add the Utility model section to Settings > Profile: a "Show thread recaps" `Switch` (`settings-thread-recap-toggle`, on by default) plus provider `Select`, model `Input` and base URL when needed, with `SettingRow` + `settings-index.ts` entries for each (keywords: recap, summary, resumen); verify component tests that toggling saves `threadRecapEnabled` and saving a model persists it, and that `fitness:settings-index` passes

## 5. Integration

- [ ] 5.1 Run `bun run lint` and `bun run typecheck`, and the affected test suites; verify all pass
- [ ] 5.2 Manual check on a dev stack: a Codex (or LLM API) thread left running shows a recap after 5+ minutes away, a steer sharee sees none, and switching the utility model to an OpenAI-compatible endpoint changes the recap's model
