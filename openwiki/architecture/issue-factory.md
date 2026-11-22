# Issue factory (server-run)

The issue factory runs a workflow for each issue it takes, as the user who set it up (the
**enabler**): implement the issue, open a pull request, wait for CI, fix red CI, merge. The flow,
not a setting, decides how far a run goes. Issues come in two ways:

- **Sent from funny**: the member selects issues in the Issues tab and sends them with a flow.
  They wait in the factory's **queue** and start in the order they were sent.
- **By label**, only in **automatic** mode: the factory also takes the open issues carrying its
  label, after the queue. A **manual** factory (the default for a new one) takes only what is sent.

Specs: `openspec/specs/issue-factory/spec.md`. Changes: `openspec/changes/issue-factory`
(phases 1–5), the archived `factory-flow-execution`, and `factory-manual-queue` (queue, modes,
dependencies).

All code is in `packages/server/src/services/factory/`. The client part is the factory row in a
project's settings (`components/general-settings-project/ProjectFactorySetting.tsx`,
`ProjectFactoryRuns.tsx`, data in `data/factory/`), served over the `factory` tRPC group.

> Not to be confused with `packages/orchestrator`, the standalone issue factory that runs flows
> in its own workspaces with local git. It shares the GitHub logic (`@funny/core/github-app`)
> and the `factory-issue` flow; the server factory does not run that flow.

## Pieces

| File                                                | Role                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory-settings.ts`                               | One row per (project, user): enabled (running / paused), `mode` (`manual` / `automatic`), label (automatic only), `flowName` (default `issue-to-merge`), `maxConcurrent`, `blockedReason`. Save needs `steer`.                                                                                                                                                                                     |
| `factory-watcher.ts`                                | One poll per factory (60 s; also paused factories with runs in flight). Per tick: re-check the enabler's `steer`, resolve runtime and repo, resume runs not driven in this process, then fill free slots: the queue in order, then (automatic) labelled issues; blocked issues are skipped.                                                                                                        |
| `factory-queue.ts`                                  | Sending issues (checked live: running, target resolves, flow loads, each issue open and not a PR), the flows a send may pick, the send bar's blockers, Clear queue and Stop all.                                                                                                                                                                                                                   |
| `factory-dependencies.ts`                           | Pure: whether an issue waits for its blockers (GitHub's "blocked by", read with `issueBlockers` from `@funny/core/github-app`) and why.                                                                                                                                                                                                                                                            |
| `factory-flow.ts`                                   | Loads `.funny/workflows/<flowName>.yaml` from the repo's **default branch** (contents API, App token), else the built-in. `factory-issue` is refused (workspace-only).                                                                                                                                                                                                                             |
| `factory-flow-runs.ts`                              | Runs the compiled flow with `@funny/pipelines` and writes progress to `factory_runs`; decides how a run ends.                                                                                                                                                                                                                                                                                      |
| `factory-action-provider.ts`                        | The server `ActionProvider`: agent steps are threads; `create_pr` finds the agent's PR by branch; `wait_ci` / `merge` via `factory-ci-actions.ts`; `run_command` and approvals refused.                                                                                                                                                                                                            |
| `factory-thread-waits.ts`                           | An agent step waits on the thread's persisted status, woken by `notifyTerminalStatusPersisted` and a 30 s DB poll; missing or > 24 h thread fails the step.                                                                                                                                                                                                                                        |
| `factory-test-weakening.ts`, `factory-risk.ts`      | Pure, no agent: what a pull request does to tests and CI (removed or skipped tests, lowered coverage thresholds, edited workflows), and its risk class (`high` on any such finding, more than 400 changed lines without lockfiles, or a sensitive path: `.github/**`, migrations, `auth/`, plus the factory's own list). `wait_ci` runs both once per head commit and stores the class on the run. |
| `factory-role-results.ts`                           | Reads a read-only role's structured result (see Role results): the last fenced `json` block of the thread's final message, validated against the role's schema, with one request to emit it again.                                                                                                                                                                                                 |
| `factory-run-control.ts`, `factory-follow-ups.ts`   | Stop, retry, take-over.                                                                                                                                                                                                                                                                                                                                                                            |
| `factory-thread-requests.ts`                        | Stop / follow-up to a run's threads, routed by the thread's path (`withRunnerFor` `request` target), waking a sleeping sandbox.                                                                                                                                                                                                                                                                    |
| `factory-sandbox-launch.ts`                         | Starts a thread in the enabler's sandbox (the `thread-sandboxes` launcher, `source: 'factory'`).                                                                                                                                                                                                                                                                                                   |
| `factory-pull-requests.ts`, `factory-ci-actions.ts` | CI verdict (green / red / conflict / timeout, `required_checks`) and merge only on green, with the App token capped by the enabler (`accessCapToken`); a merge pinned to a SHA (`sha`) is direct, and enables auto-merge only when GitHub holds `funny/regression-proof` pinned to this App (`isCheckHeldByApp`); publishes the proof's check with a checks-only token (`issueCheckPublisher`).    |
| `runtime/services/regression-proof.ts`              | The regression proof job on the enabler's runner (`POST/GET/DELETE /api/threads/:id/regression-proof`): head checkout twice, then base checkout, both temporary and prepared alike; verdict `pass` / `fail` (`failureKind` `test` / `environment`) / `skipped`.                                                                                                                                    |

## A run

0. **Queue** (sent issues): a send writes one `requested` row per accepted issue, with the chosen
   flow (`flow_name`) and a `queue_order`; issues sent together go oldest first. `requested` holds
   no slot and no flow drives it. A send is refused as a whole when the factory is paused or
   cannot work now (409, with the reason), and per issue when it is closed, a pull request,
   missing, or already in the factory.
1. **Admit**: each tick fills `maxConcurrent − slot-holding runs`: first the `requested` runs in
   queue order (compare-and-set `requested → queued`), then, in automatic mode, labelled issues
   (a new `queued` row, `source = 'label'`). An issue whose blockers are unfinished is skipped,
   with its `wait_reason` recorded, and the next one is tried. A blocker is finished when its
   issue is closed or it has a merged run in this factory; an unreadable blocker list blocks for
   that tick. A partial unique index (migration 098) allows one non-terminal run per issue, so a
   queued issue cannot be sent or labelled into a second run.
2. **Agent steps**: the first is a new thread on the enabler's runtime (a worktree on their runner
   via `startThreadOnRunner`, also when their runtime is `local`, so an unattended agent never
   works in their own checkout; or their sandbox). Every later agent step (e.g. a CI fix)
   **continues that thread** with a follow-up message, so the agent keeps its context. The agent
   commits, pushes the run's branch (`factory/issue-<n>-<runId8>`) and opens the PR; the server has no
   checkout. A worktree thread is created on that branch (the launch passes `branch`), so the
   thread, its worktree and the PR share one branch. A new branch starts from the remote's copy
   of the repository's DEFAULT branch, fetched first (the launch passes `baseBranch` and
   `baseFromRemote`; `createWorktree`'s `fromRemote`), so the PR holds the agent's commits only:
   not the branch the enabler's checkout is on, nor their unpushed commits. A default branch that
   cannot be read fails the step. If the branch exists already (a retried
   run), the worktree checks it out and the agent goes on from the earlier attempt
   (`worktreeBranchName`, `createWorktree`'s `reuseExistingBranch`); only when another worktree
   still holds it does the runner fall back to a name from the title. Each follow-up step sends
   `expectedBranch` (the run's branch): the runner refuses it with 409 while the thread's
   worktree is on another branch (`checkExpectedBranch`), so a worktree someone switched never
   gets the next fix, and the run parks with that reason.
3. **Regression proof** (the `regression_proof` step, between `create_pr` and `wait_ci` in the
   built-ins): the server starts a proof job on the run's thread and polls it
   (`factory-thread-requests.ts`). The changed test files must pass twice on the head and fail by
   an assertion on the merge-base; `Regression proof failed` (the agent can fix it) is retried
   with the implementer, `Regression proof unavailable` is not. The proof is stored in
   `factory_runs.regression_proof`. Guide:
   [docs/guides/factory-regression-proof.md](../../docs/guides/factory-regression-proof.md).
4. **CI**: `wait_ci` polls the PR; red or conflict hands the failure (check names and log tails)
   to the fix step via `retry.before_retry`, up to the flow's attempts. A timeout is not retried.
5. **Merge**: unless `merge.require_regression_proof: false`, the merge reads the PR head and
   merges only a head with a passing proof of that commit (the step's, or a new proof it runs),
   pinned to that SHA; every proof is also published as the `funny/regression-proof` check. When
   the direct merge is refused for a requirement, auto-merge only where that check is required
   pinned to this App, and only for the proved head (`expectedHeadOid`); while such a run waits,
   the watcher re-proves a moved head (`reproveMovedHead`) and publishes again a check that did
   not reach GitHub (the stored proof's `checkPublished: false`), without proving again. A head
   the run's checkout lacks (pushed from elsewhere) is fetched and run only for a sandbox thread
   (`runsPushedCommits`); on a host runner it gets a failing check saying so. A flow that is not proof-ready (`isProofReady`: no rules and no opt-out)
   is never admitted: the watcher leaves its issues queued and sets the factory's
   `blockedReason`.
6. **End**: merged → `merged`; completed without a merge → `waiting_human`; failed with the PR
   open → `waiting_human` at the failed step + Web Push to the enabler; failed earlier → `failed`
   (a labelled issue is re-admitted up to 3 times; a sent one is not, use Retry); failed before
   any agent ran → a label run is dropped, a sent one goes back to `requested` in its place, and
   the reason is shown as the factory's `blockedReason`.
   **No change**: when `create_pr` finds no PR and the branch has no commits ahead of the
   default branch, the run comments the agent's last message on the issue, removes its
   worktrees and parks `waiting_human` with reason `no change` (the flow stops there). A
   worktree with uncommitted files or commits only its branch has is kept and named in the
   comment: the runner checks and removes in one request (`POST /api/worktrees/remove-unchanged`),
   and a runner that cannot answer leaves the worktree in place.
   **A finished turn is not a finished agent**: a `completed` thread with a background job
   still running or a watcher pending (or one that ended in the last 2 minutes, whose wake is
   starting) still counts as running (`awaitsWake` in `factory-thread-waits.ts`), so the flow
   does not move on while the agent waits for its own tests.
7. **Finished outside the factory**: each tick looks at the parked runs (`waiting_human`, `failed`)
   that have a PR. If a person merged it, the run becomes `merged`; if it was closed without a
   merge, `stopped` with that reason. The write is a compare-and-set from the parked states
   (`closeParked`), so a run retried in the meantime is left alone. This works for any flow: a run
   with no recorded PR (its flow has no `create_pr` step) is looked up on its branch
   (`factoryRunBranch`, any state) for `BRANCH_LOOKUP_WINDOW_MS` (14 days) after it parked, and
   the PR found is recorded. A paused factory keeps polling while it has such a run
   (`awaitsPullRequest`), and stops once none is left.
8. **Cleanup on merge**: when a run becomes `merged` (by its `merge` step or by step 5), the
   server removes its threads' worktrees and local branches on the enabler's runner
   (`cleanupFactoryWorktrees`, `DELETE /api/worktrees`) and clears them on the thread rows.
   Only idle worktree threads on a local runner; a sandbox has its own lifecycle. Best effort:
   an offline runner leaves them in place. A run closed without a merge keeps its worktree.

Each run executes its own `flow_name` (resume, retry and take-over too); rows from before the
queue fall back to the factory's flow.

Built-in flows (`packages/workflows/defaults/`): `issue-to-merge` (default) and `issue-to-pr` (stops
at the PR for teams that merge by hand).

## Role results

A read-only factory role (the reviewer; later triage and the sentinel, change
`factory-agent-roles`) ends its final message with one fenced `json` block. The server never
reads the role's prose as a decision:

- `readRoleResult` (`factory-role-results.ts`) takes the **last** `json` block of the thread's
  final message and validates it with the role's zod schema in `@funny/shared/contracts/factory`
  (`factoryReviewResultSchema`: `sha`, `verdict` `pass` / `fail`, `findings` with a `severity`).
  Unknown fields are dropped.
- A missing or invalid result gets **one** follow-up on the same thread asking to emit it again.
  The request names the problem and never repeats the invalid text.
- Still invalid: the caller applies the role's failure rule. A review fails closed (no merge,
  the run waits for a person).
- A review holds for the commit it names (`sha`, in full). `reviewAllowsMerge` decides what a
  verdict allows: a `pass`, or a `fail` whose findings are all below `high`.

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

- **Pause**: turning the factory off stops admissions; runs in flight finish, the queue is kept
  and sending is refused. Pausing does not change the mode.
- **Cancel / Clear queue** (`factory.stopRun` on a waiting run, `factory.clearQueue`): waiting
  issues end `stopped`; runs in progress go on.
- **Stop all** (`factory.stopAll`, confirmed in the UI): clears the queue and stops every run in
  flight.
- **Stop** (`factory.stopRun`): the run is `stopped`, its flow stops and its running threads are
  stopped on the enabler's runner. A thread whose launch raced the stop is stopped when recorded.
- **Retry** (`factory.retryRun`): a `failed` / `waiting_human` run goes back in flight on the same
  branch and PR; a completed implement step is kept, later steps run again. A `no change` run
  keeps nothing (replaying its thread would only reach `no change` again): a new agent starts.
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

Possible improvements not yet implemented (orphaned-worktree sweep, sandbox runs, metrics, …) are
listed in [issue-factory-improvements.md](issue-factory-improvements.md).
