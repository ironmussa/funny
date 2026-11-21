# Proposal

## Why

The issue factory exists today only as a standalone process (`packages/orchestrator`,
ADR 0001): its own SQLite run store, its own YAML config, its own GitHub App and its own
polling loop, with no funny UI and no shared state. ADR 0002 decided the factory belongs
inside funny as three levels — trigger → flow → thread — turned on per project. This
change builds that: a per-project toggle that watches a repo's issues for a label and runs
a flow (implement → checks → PR → CI → merge) as whoever turned it on, visible in funny.

## What Changes

- A **per-project factory**: a toggle plus settings (watched label, flow name, max
  concurrent, which issues), stored per `(project, user)`. Turning it on makes funny watch
  that repo's GitHub issues for the label and run the flow; turning it off stops taking new
  issues but lets in-flight runs finish.
- A **GitHub issue-label trigger**: the server polls the watched repo's issues through the
  existing repo-scoped App token (no webhook ingress yet), admits labelled issues, and
  starts a flow run per issue. **New** — the server has no issue watcher today.
- A **server-side flow executor** that drives a multi-step flow, mirroring the automation
  scheduler's pattern (start a thread on the owner's runner, complete from the thread's
  terminal status) but across steps with retries and a run record.
- The flow runs **as whoever enabled the factory, on that person's runtime** — resolving
  their `project_runtime_settings` row (local / worktree / sandbox). This is phase 3 of the
  `project-runtime-settings` change, which had no consumer until now.
- **New YAML step types** `wait_ci` and `merge` in `@funny/workflows`, so "wait for CI" and
  "merge" are deterministic flow steps. Today they exist only as imperative orchestrator
  code (`orchestrator/src/factory/pull-request.ts`, `merge.ts`).
- The factory reads its flow from the repository's **default branch, never a PR branch**,
  so an agent cannot add itself a `merge` step in its own PR (ADR 0002).
- It **turns itself off** if the enabler loses project access or deletes their account.

## Capabilities

### New Capabilities

- `issue-factory`: a per-project, per-user automation that watches a repo's GitHub issues
  for a label and runs a deterministic multi-step flow (implement → checks → PR → CI →
  merge) to completion, as the enabling user on their runtime, with a visible run per
  issue and operator controls (pause, stop, retry, take over).

### Modified Capabilities

<!-- None. The "run as the enabler on their runtime" behaviour (phase 3 of
     project-runtime-settings) is captured as a requirement of the new
     issue-factory capability below, since project-runtime-settings is not yet
     archived and has no main spec to delta against. -->

<!-- Phase 3 of project-runtime-settings lives here, not as a delta. -->

## Impact

- **Reuse:** `@funny/workflows` (schema, catalog loader, compiler), the `factory-issue.yaml`
  built-in flow, the `@funny/pipelines` engine, the server's GitHub App token issuer
  (`github-app/token-issuer.ts`, `sandbox-tokens.ts`), and the orchestrator's `factory/*`
  - `domain/*` as the reference algorithm.
- **New schema (`packages/shared`):** `factory_settings` (mirrors `automations`) and
  `factory_runs` (mirrors `pipeline_runs`), keyed per `(project_id, user_id)`.
- **New server services:** a factory watcher/executor mirroring `automation-scheduler.ts`
  - `automation-runs.ts`, plus routes and a tRPC port for the settings and run list.
- **New `@funny/workflows` step types:** `wait_ci`, `merge` (schema + `ActionProvider` +
  compiler binding); the server implements their `ActionProvider` methods.
- **Client:** a Factory tab per project (toggle, settings, run list linking to each step's
  thread).
- Out of scope: GitHub webhook ingress (polling only for v1), multi-repo/global factory,
  retiring the standalone orchestrator.
