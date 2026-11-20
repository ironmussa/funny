# Proposal

## Why

The in-server issue factory (change `issue-factory`, phases 1–2) admits a labelled
issue and starts a single `implement` thread, then stops at `waiting_human`. ADR 0002
commits the factory to letting **the flow decide how far a run goes** (implement → checks
→ PR → CI → merge), so that a repository can change that policy by editing a workflow file
with no server deploy. Today nothing runs the flow: `flowName` is stored but ignored, and
there is no `wait_ci` or `merge` step anywhere except the standalone orchestrator's
imperative code. This change makes the factory actually execute its flow through the
`@funny/workflows` + `@funny/pipelines` engine and adds the two GitHub steps the
end-to-end path needs.

## What Changes

- Replace the factory watcher's single-thread dispatch with **flow execution**: compile the
  factory's configured flow (default `factory-issue` / a new `issue-to-merge`) and run it
  through `@funny/pipelines`, driven by a **server-side `ActionProvider`** that starts and
  awaits agent threads on the enabler's runner via `startThreadOnRunner` (today the only
  `ActionProvider` is the runtime's in-process `pipeline-adapter`).
- Add two workflow node types to `@funny/workflows` — **`wait_ci`** (poll the PR's checks to
  a terminal verdict) and **`merge`** (enable auto-merge / merge, optionally delete the
  branch) — in `schema.ts`, the `ActionProvider` contract, and the `yaml-compiler` binding.
  **BREAKING** for `ActionProvider` implementers: two new methods (`waitCi`, `merge`) they
  must implement (runtime adapter + test fakes).
- Implement the server's `waitCi` / `merge` `ActionProvider` methods by **reusing the
  orchestrator's `github-app-pull-requests` logic** (CI state, enable auto-merge, merge
  state, delete branch) with a repo-scoped GitHub App token.
- Wire the **CI-driven fix loop**: a red `wait_ci` drives a fix agent step up to the flow's
  retry limit via `retry.before_retry`; green advances to `merge`.
- **Load the flow from the repository's default branch**, never the PR branch, closing the
  "an agent adds its own merge step" hole.
- Extend the built-in `factory-issue.yaml` (or add `issue-to-merge.yaml`) to
  implement → checks → PR → `wait_ci` → `merge`.

Out of scope (unchanged): phases 1–2 schema/settings/watcher/`factory-github`; the
standalone orchestrator; a GitHub webhook ingress (polling stays).

## Capabilities

### New Capabilities

- `issue-factory`: the in-server factory's run lifecycle — admission (from phases 1–2),
  executing the configured flow through the pipelines engine as the enabler, the
  `wait_ci` and `merge` step semantics, loading the flow from the default branch, the
  CI-driven fix loop, and how a run reaches a terminal state (merged / failed / waiting).

### Modified Capabilities

<!-- None: no existing spec covers the factory or the workflow engine. The prior
     issue-factory change has not been archived to a spec, so its behavior is folded
     into the new issue-factory capability here. -->

## Impact

- **`@funny/workflows`** (shared DSL): `schema.ts` node union, `compiler/action-provider.ts`
  contract, `compiler/yaml-compiler.ts` binding, `defaults/*.yaml`. Every `ActionProvider`
  implementer gains two methods.
- **`packages/server`**: a new flow-execution path in `services/factory/` (server
  `ActionProvider` + pipeline run), reusing `services/github-app/` tokens and a server port
  over the orchestrator's `github-app-pull-requests` adapter; the watcher's dispatch swaps
  from `startThreadOnRunner`-only to running the flow.
- **`packages/runtime`**: `pipeline-adapter` implements the two new `ActionProvider` methods
  (or explicitly no-ops them where CI/merge is server-only).
- **GitHub**: additional API use (checks polling, merge) under the existing repo-scoped App
  token; polling quota noted in design.
- **Tests**: `@funny/workflows` compiler/schema, the server CI/merge provider, the fix loop,
  and default-branch flow loading.
