# Tasks

## 1. Background task lifetime (agent-background-task-lifetime)

- [x] 1.1 Keep the SDK input channel open until the turn and all non-ambient background tasks finish (`sdk-claude.ts` `trackInputLifetime`), verified by `src/__tests__/sdk-claude-input-lifetime.test.ts` failing on the old code and passing now
- [ ] 1.2 Manually verify on a restarted runner that a background subagent's Bash call after the main turn's result succeeds and the agent process exits afterwards (check `~/.funny/logs` for no auto-denials and a process exit)
- [x] 1.3 Commit the fix with its test

## 2. Project access control (project-access-control)

- [x] 2.1 Add server `requireProjectAccess(level)` middleware backed by the authorizer, with tests for owner / member / org / unrelated user / non-existent id (identical 404)
- [x] 2.2 Replace inline project checks in `server/src/routes/{settings,designs,projects,project-runner-settings}.ts` with the middleware; verify route tests and that org members now read settings and designs
- [x] 2.3 Make runtime GitHub routes (`prs`, `issues`, `pr-files`, `pr-threads`) authorize via `requireProject` and pass the project into `resolveGithubProjectContext({ optionalToken })`; add a regression test proving a foreign project id gets 404 with no git/GitHub/token call
- [x] 2.4 Apply the same to `routes/tests.ts`; verify its tests
- [x] 2.5 Document the project-access rule next to the thread-access rule in CLAUDE.md / openwiki and verify the links resolve

## 3. Other correctness fixes

- [x] 3.1 Add runtime `ensureThreadCwd` using `resolveThreadCwd`, use it in `text-search.ts` (×2), `browse.ts`, and `requireThreadCwd`; add a test that a scratch thread resolves its scratch directory
- [x] 3.2 Resolve the `startScheduler` open question → automations are broken end to end (cron never started, runner automation repo is a stub, manual trigger always 404); decided to rebuild execution server-side in the separate change `automation-execution`
- [x] 3.3 Remove the broken Better Auth fallback in `runtime/src/middleware/auth.ts` (return 401 when server session validation fails); verify middleware tests

## 4. Persistence schema consistency (persistence-schema-consistency)

- [x] 4.1 Add the schema-drift test (retired columns dropped by migration 081) (both definitions + freshly migrated SQLite/Postgres) and confirm it fails on the current `projects.closed` gap
- [x] 4.2 ~~Introduce `defineTables(b)` with sqlite/pg builders; regenerate `schema.sqlite.ts` / `schema.pg.ts` from it; drift test and `pg-epoch-ms-columns` / `better-auth-user-schema` tests pass~~ — dropped (decision 2026-10-04): the schema-drift test already prevents divergence; a full schema rewrite is not worth the risk
- [x] 4.3 Register an int8 parser in the pg adapter; add a test that `watchers.nextWakeAt` reads back as a number on Postgres
- [x] 4.4 Replace `server/src/db/schema.ts` named re-exports with `export *`, add `server/src/db/repos.ts` lazy repository registry, remove `schema as any` casts; typecheck passes
- [x] 4.5 Unify the repositories' `*Deps` types into one `RepoDeps`; delete `shared/src/db/columns.ts` and its vitest alias; typecheck passes

## 5. Dead code removal — packages and core

- [x] 5.1 ~~Delete `packages/reviewbot` (and its `sdk` usage) after confirming no CI/script reference; typecheck + root `bun install` succeed~~ — kept as is (decision 2026-10-04): standalone services may be deployed outside the repo
- [x] 5.2 ~~Delete `packages/memory` and `packages/harness`; update openwiki references; typecheck succeeds~~ — kept as is (decision 2026-10-04): standalone services may be deployed outside the repo
- [x] 5.3 ~~Move `packages/design-client/docs` to `docs/design-client/` and delete the package; verify links~~ — kept as is (decision 2026-10-04): standalone services may be deployed outside the repo
- [x] 5.4 Delete `core/src/containers/` and its `./containers` export; fix doc references; core tests pass
- [x] 5.5 Delete dead `fetchPRReviews`, `checkPRApprovalStatus`, `mergePR` (and their test) and unused `cloneRepo`, or route `runtime/routes/github/repos.ts` clone through core; tests pass
- [x] 5.6 Move `shared/src/evflow.model.ts` into `packages/evflow`, drop the `@funny/evflow` dependency and export from shared; evflow model test passes

## 6. Dead code removal — runtime

- [ ] 6.1 Point `__tests__/helpers/test-db.ts` at `@funny/shared/db/schema-sqlite`, then delete `runtime/src/db/` and the local-DB parts of `lib/auth.ts`; runtime tests pass
- [ ] 6.2 Remove PTY DB persistence branches and `pty-backend-tmux.ts`; decide on headless/bun backends (keep daemon + node-pty + null); PTY tests pass
- [ ] 6.3 Delete `services/transcribe-stream.ts` and the zero-reference exports listed in the audit; fix stale `package.json` exports (`./app`, `./lib/auth`) and `drizzle.config.ts`; typecheck passes

## 7. Dead code removal — client

- [ ] 7.1 Delete `components/kanban/` duplicates (or wire them and remove the inline copies in `KanbanView.tsx`); Kanban stories and tests pass
- [ ] 7.2 Delete the ~25 unimported components/hooks after grepping file stems and testids (check Playwright/visual-parity entry points); `bun run build` passes
- [ ] 7.3 Delete `use-opencode-prompt-models.ts`, `opencode-models-store.ts`, and the related API/types; build passes
- [ ] 7.4 Migrate the ~32 `useAppStore` call sites and ~60 test `setState` calls to the owning stores, delete `stores/app-store.ts`, update CLAUDE.md; client tests pass

## 8. Pattern refactors — server/shared/runtime

- [ ] 8.1 Convert `data-handler.ts` to the typed handler registry and derive `DATA_SCOPE_RULES` and the gRPC operations list from it; add a test that every registered type has a scope rule and unknown types are refused
- [ ] 8.2 Rewrite `runner-service-provider.ts` as a table-driven proxy with `noopRepo`, removing provider-only `.bind()` re-exports and unused remote functions; `team-client` and provider tests pass
- [ ] 8.3 Move `resultToResponse` to `@funny/shared`, add `parseOr400`, and adopt both in server routes; route tests pass
- [ ] 8.4 Extract `runSubAgent` (git-pipelines ×4, event-based wait with timeout) and `persistAndAnnounce` / `buildThreadRow` (thread-service/create ×4); pipeline and thread-service tests pass
- [ ] 8.5 Share `decodeUnicodeEscapes` / `normalizeToolResultContent` between `agent-message-handler.ts` and `ingest-mapper.ts`; ingest tests pass
- [ ] 8.6 Merge the server and runtime `pipeline-approval-store` into one shared class; tests pass

## 9. Pattern refactors — core

- [ ] 9.1 Add `BaseAgentProcess` emit helpers and migrate codex, pi, generic-acp, deepagent, llm-api, and `emitErrorToolCall`; provider tests pass
- [ ] 9.2 Replace gemini/cursor/opencode ACP classes and discover shims with `makeExternalProcessClass(manifest)` in `process-factory.ts`; process-factory tests pass
- [ ] 9.3 Add `gh()` and `nativeOr()` in `core/git`, migrate `github.ts`, `remote.ts`, and native/CLI branches with one error mapper; git tests pass

## 10. Pattern refactors — client

- [ ] 10.1 Replace the `applyWebEvent` switch, `ALL_EVENT_TYPES`, and the `flushWSBuffer` switch with one typed event registry; existing WS tests pass plus a test that every `EventType` has a handler
- [ ] 10.2 Extract `useExpandedDiffState` + `DiffToolbar` so `ExpandedDiffDialog` wraps `ExpandedDiffView`; diff tests/stories pass
- [ ] 10.3 Keep one `computeUnifiedDiff`, add `parseDiffSide`, remove `lib/diff/{parse,layout}.ts` re-exports; tests pass
- [ ] 10.4 Render ThinkCard, TaskCard, PlanCard, ExitPlanModeCard, PinnedPRCard, MediaPreview, and MonacoEditorDialog markdown through Satteri, consolidate `CopyButton`, remove `react-markdown`; build and visual checks pass
- [ ] 10.5 Extract `usePaginatedGitLog` for CommitGraphTab/CommitHistoryTab and `useProjectCrudList` for ProjectHooks/StartupCommands settings; tests pass

## 11. Integration

- [ ] 11.1 Run `bun scripts/fitness/check-typecheck.ts`, all package test suites, `bun run build`, and the Playwright E2E suite; record the net line delta (`git diff --stat master`)
