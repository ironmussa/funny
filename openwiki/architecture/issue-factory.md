# Issue factory (server-run)

The issue factory watches a project's GitHub repository for issues carrying a label and runs a
workflow for each one, as the user who turned the factory on (the **enabler**): implement the
issue, open a pull request, wait for CI, fix red CI, merge. The flow, not a setting, decides how far
a run goes. Specs: `openspec/specs/issue-factory/spec.md`. Changes:
`openspec/changes/issue-factory` (phases 1–5) and the archived `factory-flow-execution`.

All code is in `packages/server/src/services/factory/`. The client part is the factory row in a
project's settings (`components/general-settings-project/ProjectFactorySetting.tsx`,
`ProjectFactoryRuns.tsx`, data in `data/factory/`), served over the `factory` tRPC group.

> Not to be confused with `packages/orchestrator`, the standalone issue factory that runs flows
> in its own workspaces with local git. It shares the GitHub logic (`@funny/core/github-app`)
> and the `factory-issue` flow; the server factory does not run that flow.

## Pieces

| File                                                | Role                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `factory-settings.ts`                               | One row per (project, user): enabled, label, `flowName` (default `issue-to-merge`), `maxConcurrent`, `blockedReason`. Save needs `steer`.                                                                                |
| `factory-watcher.ts`                                | One poll per factory (60 s; also paused factories with runs in flight). Per tick: re-check the enabler's `steer`, resolve runtime and repo, resume runs not driven in this process, admit labelled issues up to the cap. |
| `factory-flow.ts`                                   | Loads `.funny/workflows/<flowName>.yaml` from the repo's **default branch** (contents API, App token), else the built-in. `factory-issue` is refused (workspace-only).                                                   |
| `factory-flow-runs.ts`                              | Runs the compiled flow with `@funny/pipelines` and writes progress to `factory_runs`; decides how a run ends.                                                                                                            |
| `factory-action-provider.ts`                        | The server `ActionProvider`: agent steps are threads; `create_pr` finds the agent's PR by branch; `wait_ci` / `merge` via `factory-ci-actions.ts`; `run_command` and approvals refused.                                  |
| `factory-thread-waits.ts`                           | An agent step waits on the thread's persisted status, woken by `notifyTerminalStatusPersisted` and a 30 s DB poll; missing or > 24 h thread fails the step.                                                              |
| `factory-run-control.ts`, `factory-follow-ups.ts`   | Stop, retry, take-over.                                                                                                                                                                                                  |
| `factory-thread-requests.ts`                        | Stop / follow-up to a run's threads, routed by the thread's path (`withRunnerFor` `request` target), waking a sleeping sandbox.                                                                                          |
| `factory-sandbox-launch.ts`                         | Starts a thread in the enabler's sandbox (the `thread-sandboxes` launcher, `source: 'factory'`).                                                                                                                         |
| `factory-pull-requests.ts`, `factory-ci-actions.ts` | CI verdict (green / red / conflict / timeout, `required_checks`) and merge only on green, with the App token capped by the enabler (`accessCapToken`).                                                                   |

## A run

1. **Admit**: a `factory_runs` row (`queued`) is written before anything starts; a partial unique
   index (migration 098) allows one in-flight run per issue.
2. **Agent steps**: the first is a new thread on the enabler's runtime (local / worktree on their
   runner via `startThreadOnRunner`, or their sandbox). Every later agent step (e.g. a CI fix)
   **continues that thread** with a follow-up message, so the agent keeps its context. The agent
   commits, pushes the run's branch (`factory/issue-<n>-<runId8>`) and opens the PR; the server has no
   checkout.
3. **CI**: `wait_ci` polls the PR; red or conflict hands the failure (check names and log tails)
   to the fix step via `retry.before_retry`, up to the flow's attempts. A timeout is not retried.
4. **End**: merged → `merged`; completed without a merge → `waiting_human`; failed with the PR
   open → `waiting_human` at the failed step + Web Push to the enabler; failed earlier → `failed`
   (re-admitted up to 3 times); failed before any agent ran → the row is dropped and the reason is
   shown as the factory's `blockedReason`.

Built-in flows (`packages/workflows/defaults/`): `issue-to-merge` (default) and `issue-to-pr` (stops
at the PR for teams that merge by hand).

## Restarts and races

- A run's flow lives in memory while its threads run. After a restart the next tick **resumes**
  every in-flight run: agent steps are numbered in call order and replay their recorded thread
  ids instead of starting new ones. A recorded step that a later step continued on the same thread
  counts as finished.
- `launch_started_at` is set just before a thread is started; a resumed run adopts a factory thread
  with the `[Factory] #N ` title prefix created since then (or a follow-up that reached the thread)
  instead of starting the agent twice.
- A follow-up step finishes when the thread's `completedAt` changes from its value before the
  follow-up (a compare, so the runner's clock does not matter).

## Operator controls

- **Pause**: turning the factory off stops admissions; runs in flight finish.
- **Stop** (`factory.stopRun`): the run is `stopped`, its flow stops and its running threads are
  stopped on the enabler's runner. A thread whose launch raced the stop is stopped when recorded.
- **Retry** (`factory.retryRun`): a `failed` / `waiting_human` run goes back in flight on the same
  branch and PR; a completed implement step is kept, later steps run again.
- **Take over**: when the thread's **owner** follows up on a parked run's last thread after it
  parked (noted by `POST /api/threads/:id/message`), the run resumes from that step when the thread
  completes. A steer sharee's follow-up never does: it would otherwise move the flow toward a merge
  in the enabler's name. The note is in memory; after a restart use Retry.
- **Lost access**: if the enabler loses `steer`, the factory is turned off and their open runs are
  stopped (`factory.disabled_access_lost` audit).

## Security boundaries

- Every thread, follow-up and stop is the enabler's, on their own runner or sandbox
  (`withRunnerFor`), never another user's.
- GitHub calls use the deployment's GitHub App token for the repo, capped by the enabler's own
  access; a read-level enabler cannot merge. A merge happens only on green checks and does not
  bypass branch protections.
- The flow is read only from the default branch; issue text is not inlined into prompts (the agent
  reads the issue by URL).
