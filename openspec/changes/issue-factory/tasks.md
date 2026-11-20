# Tasks

## 1. Schema + settings (phase 1)

- [x] 1.1 Added `factory_settings` and `factory_runs` to `schema.sqlite.ts` and `schema.pg.ts` (mirrored, with the dialect-mirror marker).
- [x] 1.2 Migration `097_issue_factory` creates both tables + indexes; mirrored in the test-db helper.
- [x] 1.3 `factory-settings` service (CRUD) and `factory-runs` repository (list, activeByIssue, countActive, start, update, stopMany). The owner-or-member access check was extracted to a shared `services/project-access.ts` used by the factory and the sandbox services.
- [x] 1.4 REST route `/api/factory` (GET/PUT settings, GET runs), NOT tRPC. Deviation: the sibling project-sandbox settings are also plain REST (`routes/infra.ts`), so the factory matches that pattern; a later tRPC migration can follow when the group moves.
- [x] 1.5 Client: `ProjectFactorySetting` in the project settings section (On/Off toggle + label, flow, concurrency), via `factoryApi` and the `useProjectFactory` hook. shadcn + data-testids. (A dedicated tab + run list is deferred to when runs exist in phase 2+.)
- [x] 1.6 Tests: settings service (access scoping), the run repository, the REST route (access + validation), and the client component.

## 2. Watcher + implement run (phase 2)

- [x] 2.1 `services/factory/factory-watcher.ts` mirrors `automation-scheduler.ts`: one interval poll per enabled factory (`listEnabledFactories`), re-reads the factory each tick, and admits open+labelled issues not already running (`runs.activeByIssue`) under the concurrency cap (`runs.countActive`). `routes/factory.ts` calls `rescheduleFactory` on save so enable/disable applies without a restart; started from `hosts/bun/main.ts`.
- [x] 2.2 `services/factory/factory-github.ts`: repo resolved from the project's runner via `createSandboxRunnerCalls(...).projectRemoteUrl` + `githubRepoOf` (the same path `prepareSandboxLaunch` uses; no new column). Issues read with a repo-scoped App token (`github-app/token-issuer.ts`, owner PAT via `serverSideProjectGithubToken ?? getProviderKey`) over REST `GET /repos/{repo}/issues?state=open&labels=<label>&sort=created&direction=asc`, PRs filtered. Deviation: no cached `thread_sandboxes.repo_url` fallback and single-page (per_page=100) for v1 — a runner-offline tick is a logged no-op, like an automation tick.
- [x] 2.3 `startThreadOnRunner` starts the `implement` thread as the ENABLER (`source: 'factory'`). Runtime resolved from the enabler's `project_sandbox_settings.mode`. Deviation: phase 2 honors `local` and `worktree`; a `sandbox` runtime falls back to `local` (the sandbox provisioning path is phase 3+), per "default local".
- [x] 2.4 `services/factory/factory-runs-completion.ts` `onFactoryThreadTerminal` (sibling of `onAutomationThreadTerminal`, wired in `data-message-handlers.ts`): completed implement → `waiting_human` (non-terminal, blocks re-admitting the issue; phase 4 frees the slot); failed → `failed`. Run lookup by thread id via `runs.findByThreadId`.
- [x] 2.5 Tests (`__tests__/services/factory/factory-watcher.test.ts`, 8): scheduling of enabled factories only, admission + dispatch as the enabler, one-run-per-issue dedup, concurrency cap, repo-unresolvable skip, and terminal completion (waiting_human / failed / unknown-thread). Runtime-resolution-by-row and offline-runner paths are exercised via the injected `resolveRuntime` / `launch` fakes.

## 3. CI + merge steps (phase 3)

- [x] 3.1 (done in factory-flow-execution, archived 2026-11-16) Add `wait_ci` and `merge` node types to `@funny/workflows` `schema.ts`, the `ActionProvider` contract (`action-provider.ts`), and the compiler binding (`yaml-compiler.ts`).
- [x] 3.2 (done in factory-flow-execution: logic moved to @funny/core/github-app) Implement their `ActionProvider` methods on the server by reusing the orchestrator's `github-app-pull-requests.ts` logic (CI state, enable auto-merge, merge state, delete branch).
- [x] 3.3 (done in factory-flow-execution; fixes continue the implement thread, 7d2310b5a) Wire the CI-driven fix loop (green → ready/merge, red → fix step up to the flow's retry limit) using the flow's `retry.before_retry`.
- [x] 3.4 (done in factory-flow-execution) Load the flow from the repo's DEFAULT branch via the catalog loader; never the PR branch. Test that a PR-branch flow edit is ignored.
- [x] 3.5 (done: issue-to-merge.yaml + issue-to-pr.yaml; factory-issue refused on the server) Extend the built-in `factory-issue.yaml` (or a new `issue-to-merge.yaml`) to implement → checks → PR → wait_ci → merge.
- [x] 3.6 (done in factory-flow-execution) Tests: the wait_ci/merge steps, the fix loop, default-branch flow loading.

## 4. Operator controls + lifecycle (phase 4)

- [x] 4.1 (2183e1423: pause keeps runs in flight, stopRun, retryRun, take-over by follow-up) Pause the factory (no new admissions, in-flight continue); stop a single run; retry a failed step; take over by following up on the thread (the run continues from that step).
- [x] 4.2 (2183e1423: failure with PR open → waiting_human at the step + Web Push; UI badge) Surface "waiting for the member" (e.g. CI failed beyond the limit); a notification.
- [x] 4.3 (06f647303 + 2183e1423: auto-off on lost steer, open runs stopped; a deleted account has no role, so the same check applies) Auto-disable the factory when the enabler loses project access or deletes their account; another member re-enables in their own name.
- [x] 4.4 (factory-watcher.test.ts 'factory operator controls', factory-trpc.test.ts) Tests: pause/stop/retry/take-over, waiting state, auto-off on lost access.

## 5. Verification

- [x] 5.1 `bun run lint` and `bun run typecheck` green.
- [x] 5.2 `bun run format` (oxfmt) on touched files.
- [x] 5.3 `openspec validate issue-factory --strict` passes.
