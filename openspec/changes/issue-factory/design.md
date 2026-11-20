# Design

## Context

The standalone orchestrator (`packages/orchestrator`, ADR 0001) already implements the
whole factory algorithm — admission (`factory/admission.ts`), implement
(`factory/implement-run.ts`), CI-driven fix loop (`factory/pull-request.ts`), merge
(`factory/merge.ts`), a state machine (`domain/factory-run.ts`) — but as a separate
process with its own SQLite run store, its own YAML config, its own "Factory App" and its
own REST polling. It does not touch the funny server.

Inside the server we already have the closest pattern in the **automation scheduler**
(`services/automation-scheduler.ts` + `automation-runs.ts`): one `croner` job per enabled
automation, `startThreadOnRunner` on the owner's runner, completion driven by the thread's
terminal status (`onAutomationThreadTerminal`, fired from `data-message-handlers.ts`), a
stale-run sweep, single-instance assumption. The schema precedents are `automations` /
`automation_runs` and the richer multi-step `pipelines` / `pipeline_runs`.

`@funny/workflows` gives us the flow vocabulary (`schema.ts`: `spawn_agent`,
`run_command`, `git_commit`, `git_push`, `create_pr`, `notify`, `set_status`, `approval`,
`pipeline`; node-level `depends_on`, `when`, `on_error`, `retry.before_retry`, `loop`), a
catalog loader that merges built-in + repo `.funny/workflows/*.yaml`, and a compiler to
the `@funny/pipelines` engine. The built-in `factory-issue.yaml` already covers
implement → checks → commit → push → draft PR. It has **no `wait_ci` or `merge`** step —
those live only as imperative orchestrator code.

The GitHub App token issuer (`github-app/token-issuer.ts`, `sandbox-tokens.ts`) already
mints a repo-scoped, owner-access-capped installation token; the factory's polling and
git steps reuse it. There is **no issue webhook or watcher in the server today.**

## Goals / Non-Goals

**Goals:**

- Run the factory inside the server, per project, as the enabling user on their runtime.
- Reuse `@funny/workflows` + `@funny/pipelines` + the orchestrator's algorithm; do not
  reinvent the state machine.
- Mirror the automation scheduler's start-on-owner's-runner + complete-from-terminal
  pattern, extended to multi-step flows.

**Non-Goals:**

- A GitHub webhook ingress (poll only for v1).
- A global / multi-repo factory; retiring the standalone orchestrator.
- Porting the orchestrator's code verbatim — reference, not lift-and-shift.

## Decisions

1. **New schema, mirroring existing precedents.** `factory_settings` keyed per
   `(project_id, user_id)` (enabled, label, flow_name, max_concurrent, created/updated),
   like `automations`; `factory_runs` (factory FK, issue_number, pr_url, state, current
   step, thread ids, started/completed), like `pipeline_runs`. Raw-SQL migration in
   `db/migrate.ts`, both dialects, as every other table.

2. **A server-owned watcher + executor**, structured like `automation-scheduler.ts`: one
   polling job per enabled factory (interval, not cron), admission reusing the
   orchestrator's rules, and a run driven step-by-step. Threads start via
   `startThreadOnRunner` (the same use case as automations / `POST /api/threads`) on the
   enabler's runner; a thread step completes from the thread's terminal status
   (`onAutomationThreadTerminal`'s sibling). Single-instance assumption, like the
   scheduler, documented.

3. **Runtime from the enabler (phase 3 of project-runtime-settings).** Before building the
   creation payload, resolve the enabler's `project_sandbox_settings` row
   (`ProjectSandboxView.mode` + connection) and set `mode`/`runtime` accordingly, default
   local. This is the first real consumer of the per-user runtime row. Routing stays on
   the certified `withRunnerFor` sink — never another user's runner.

4. **`wait_ci` and `merge` become YAML step types.** Add them to `@funny/workflows`
   `schema.ts`, the `ActionProvider` contract, and the compiler binding; the server
   implements their `ActionProvider` methods by reusing the orchestrator's
   `github-app-pull-requests.ts` logic (CI state, enable auto-merge, merge state). This
   keeps "how far a run goes" in the flow, per ADR 0002, instead of a setting.

5. **Flow read from the default branch.** The executor loads the flow from the repo's
   default branch via the catalog loader against a default-branch checkout, never the PR
   branch, closing the "agent adds its own merge step" hole.

6. **Phased delivery**, each phase shippable:
   - (1) schema + `factory_settings`/`factory_runs` + the tRPC port and Factory tab
     (toggle + run list), no execution yet.
   - (2) the watcher + single-thread "implement" run via `startThreadOnRunner`, resolving
     the enabler's runtime (phase 3), completing from terminal status.
   - (3) the `wait_ci` + `merge` step types and the CI-driven fix loop; full
     implement → CI → merge flow.
   - (4) operator controls (pause, stop, retry, take over) and the lost-access auto-off.

## Risks / Trade-offs

- **Polling vs. webhook.** Polling is simple and reuses the token issuer, but is laggy and
  spends API quota. Accepted for v1; a webhook ingress can replace the poll later without
  changing the executor.
- **Single-instance assumption** (shared with the automation scheduler). A second server
  instance would double-run; same constraint and mitigation as today.
- **Reference vs. reuse of the orchestrator.** Re-implementing the fix/merge loop in the
  server risks drift from the orchestrator's battle-tested logic. Mitigation: extract the
  shared decision helpers (`domain/*`) where cheap, reference the rest.
- **Read-only vs. write runtime.** Unlike automations (read-only, always local), factory
  runs write and open PRs, so sandbox/worktree runtimes matter here — hence phase 3. A
  sandbox run provisions real infra per issue; concurrency caps bound the cost.
- **GitHub App required.** Without the deployment's App installed on the repo, the factory
  cannot mint tokens; it must surface a clear "install the App" error, like sandbox
  threads do today.
