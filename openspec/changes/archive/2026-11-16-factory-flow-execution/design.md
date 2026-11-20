# Design

## Context

See `proposal.md` — Why. State today (change `issue-factory`, phases 1–2):

- `services/factory/factory-watcher.ts` admits an issue and calls `startThreadOnRunner`
  once for an `implement` thread; `factory_runs` tracks `threadIds` + `currentStep`;
  `onFactoryThreadTerminal` closes the run at `waiting_human`/`failed`. `flowName` is stored
  but unused.
- `services/factory/factory-github.ts` resolves the repo (`projectRemoteUrl` + `githubRepoOf`)
  and mints a repo-scoped App token capped by the enabler (`github-app/token-issuer.ts`).
- `@funny/workflows` compiles a YAML flow to a `@funny/pipelines` graph against an injected
  `ActionProvider` (`compiler/action-provider.ts`): `spawnAgent`, `runCommand`, `gitCommit`,
  `gitPush`, `createPr`, `notify`, `setStatus`, `setStage`, `requestApproval`. The **only**
  `ActionProvider` implementation is the runtime's in-process `pipeline-adapter.ts`, which
  runs agents and git in the same process as the checkout. `defaults/factory-issue.yaml`
  stops at a draft PR.
- The standalone orchestrator (`packages/orchestrator`) already has battle-tested CI/merge
  logic in `adapters/github-app-pull-requests.ts` and the `factory/pull-request.ts` /
  `factory/merge.ts` follow-ups.

The hard new constraint: the factory's `ActionProvider` runs **on the server**, but agent
work must run **on the enabler's runner**. So the server provider cannot reuse the runtime's
in-process adapter; it drives threads remotely and waits for their terminal status (the
Phase-2 signal), while doing CI/merge itself with the App token.

## Goals / Non-Goals

**Goals:**

- Execute the factory's flow through `@funny/workflows` + `@funny/pipelines` from the server,
  as the enabler, so the flow decides how far a run goes (ADR 0002).
- Add `wait_ci` + `merge` as first-class, reusable workflow node types.
- Reuse the orchestrator's PR/CI/merge logic rather than re-implementing it.

**Non-Goals:**

- A webhook ingress (polling stays, per `issue-factory`).
- Changing phases 1–2 schema/settings/watcher/token paths.
- Retiring the standalone orchestrator or unifying its run store with `factory_runs`.
- Running the flow's agent steps in-process on the server (they run on the runner).

## Decisions

1. **A server `ActionProvider` that drives threads remotely and bridges to the pipeline.**
   `spawnAgent` starts (or resumes) a thread via `startThreadOnRunner` on the enabler's
   runner and resolves when that thread reports terminal status — reusing the Phase-2
   terminal signal (`onFactoryThreadTerminal`'s mechanism) as the await, not an in-process
   wait. A run's pipeline execution is suspended across the thread's lifetime and resumed
   from the durable terminal status, so a server restart does not strand it. `gitCommit` /
   `gitPush` / `createPr` for a factory run are performed by the agent thread itself on the
   runner (the flow instructs it), so the server provider implements them as no-ops or
   thin acknowledgements; only `wait_ci` and `merge` are genuinely server-driven. _Alternative
   rejected:_ a second in-process adapter on the server — impossible, the checkout is on the
   runner and the server has no working tree.

2. **`wait_ci` and `merge` are new node types in `@funny/workflows`, server-implemented via a
   PR port.** Add them to `schema.ts` (node union + options), `compiler/action-provider.ts`
   (two methods: `waitCi(opts)`, `merge(opts)`), and `compiler/yaml-compiler.ts` (binding).
   The server implements them over a small `FactoryPullRequests` port backed by the
   orchestrator's `github-app-pull-requests` logic, given the run's repo + PR + App token.
   _Alternative rejected:_ keep CI/merge as imperative server steps outside the flow — that
   is Path B, which contradicts ADR 0002 and the `issue-factory` spec.

3. **New `ActionProvider` methods are additive but BREAKING for implementers.** The runtime
   `pipeline-adapter` and every test fake must implement `waitCi`/`merge`. The runtime
   adapter's CI/merge is out of scope here (pipelines on the runner do not merge PRs), so it
   implements them as explicit "unsupported in this context" results; the factory's server
   provider is the real implementation. _Alternative rejected:_ optional methods — optionality
   hides the contract and lets a flow silently no-op a merge.

4. **Flow loaded from the default branch via the catalog loader against a default-branch
   read.** The executor resolves the flow from the repo's default branch (built-ins +
   `.funny/workflows/*.yaml` as seen on that branch), never the PR branch — satisfying the
   spec's PR-branch-ignored requirement and closing the self-modifying-merge hole. The read
   uses the App token (contents:read), not a runner checkout, so it does not depend on the
   working tree's branch.

5. **`factory_runs` state maps to flow progress.** `currentStep` tracks the running node;
   `wait_ci`/fix iterations update it; `merge` success → `merged`; retry-exhaustion or a
   failed required step → `failed`/`waiting_human` per the spec. The existing
   `onFactoryThreadTerminal` becomes the resume hook for the provider's `spawnAgent` await
   rather than a direct run-completer.

6. **Built-in flow.** Add `defaults/issue-to-merge.yaml` (implement → checks → PR →
   `wait_ci` → `merge`) and make it the default `flowName`; keep `factory-issue.yaml`
   (stops at draft PR) for deployments that want human merge.

## Risks / Trade-offs

- **Suspending a pipeline across a remote thread's lifetime** → the provider must persist
  enough to resume from terminal status after a restart; mitigate by keying the await on the
  run + thread id already in `factory_runs`, and treating a missing or stale thread as a
  failed step.
- **CI polling cost and latency** → `wait_ci` polls under the App token; bound with an
  interval + timeout and only while a run is in the `wait_ci` step. A webhook can replace the
  poll later without changing the node's contract.
- **Contract break ripples to all `ActionProvider` implementers** → keep the two methods
  small and land the DSL + implementers in one change so nothing compiles half-migrated.
- **Drift from the orchestrator's logic** → reuse `github-app-pull-requests` through a shared
  port rather than copying; where the server needs its own cap (owner-access), layer it like
  the existing sandbox token issuer does.
- **Merging unattended** → `merge` only on green required checks; protected branches/rulesets
  remain the backstop (as the steer-share dialog already warns).

## Open Questions

- Whether the default `flowName` should flip to `issue-to-merge` for existing enabled
  factories, or only for newly enabled ones (a settings-default vs. migration choice). Safe
  to decide at implementation of the built-in flow without changing the specs or approach.
