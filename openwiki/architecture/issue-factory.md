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
project's settings (`components/general-settings-project/ProjectFactorySetting.tsx`, the
configuration only; data in `data/factory/`) and the factory view (`/factory`,
`components/FactoryQueueView.tsx`: the runs, their controls, Clear queue / Stop all and the
integration figures), served over the `factory` tRPC group. See
[The factory view](#the-factory-view).

## Pieces

| File                                                        | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory-settings.ts`                                       | One row per (project, user): enabled (running / paused), `mode` (`manual` / `automatic`), label (automatic only), `flowName` (default `issue-to-merge`), `maxConcurrent`, `blockedReason`, per-step agent overrides (`step_overrides`). Save needs `steer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `factory-watcher.ts`                                        | One poll per factory (60 s; also paused factories with runs in flight). Per tick: re-check the enabler's `steer`, resolve runtime and repo, resume runs not driven in this process, then (automatic) queue the labelled issues that have no run as `requested` rows (`source = 'label'`, dropped again when the label goes or the factory turns manual) and fill free slots from the queue in order, starting the admitted runs together; blocked issues are skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `factory-queue.ts`                                          | Sending issues (checked live: running, target resolves, flow loads, each issue open and not a PR), the flows a send may pick, the send bar's blockers, Clear queue and Stop all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `factory-dependencies.ts`                                   | Pure: whether an issue waits for its blockers (GitHub's "blocked by", read with `issueBlockers` from `@funny/core/github-app`) and why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-flow.ts`                                           | Loads `.funny/workflows/<flowName>.yaml` from the repo's **default branch** at its head commit (contents API, App token), with its prompt files from the same commit, else the built-in; then refuses what the factory cannot apply (`factory-flow-validation.ts`, see Agent step options).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `factory-flow-runs.ts`                                      | Runs the compiled flow with `@funny/pipelines` and writes progress to `factory_runs`; decides how a run ends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `factory-action-provider.ts`                                | The server `ActionProvider`: agent steps are threads; `create_pr` finds the agent's PR by branch; `wait_ci` / `merge` via `factory-ci-actions.ts`; `run_command` and `integrate` run on the runner (`factory-step-runner.ts`, `factory-integrate.ts`); approvals refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `factory-thread-waits.ts`                                   | An agent step waits on the thread's persisted status, woken by `notifyTerminalStatusPersisted` and a 30 s DB poll; missing or > 24 h thread fails the step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `factory-test-weakening.ts`, `factory-risk.ts`              | Pure, no agent: what a pull request does to tests and CI (removed or skipped tests, lowered coverage thresholds, edited workflows), and its risk class (`high` on any such finding, more changed lines than the factory's limit when its size gate is on (`sizeGateEnabled`, off by default; `maxLowRiskLines`, 400 by default), not counting tests, `*.md`, lockfiles, translations, stories, snapshots and the factory's `sizeIgnoredPaths`, or a sensitive path: `.github/**`, migrations, `auth/`, plus the factory's own list). `wait_ci` runs both once per head commit and stores the class on the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `factory-review.ts`                                         | The reviewer: one new read-only thread per head commit (`permissionMode: plan`, write tools denied, never the implementing thread), a server-built prompt (commit, pull request, issue URL, the server's findings), the validated verdict stored per commit in `factory_runs.review_verdicts`. No verdict after one re-emit request parks the run (`review gave no verdict`). Review threads are not in `threadIds`; `threadsOf` (`factory-runs.ts`) adds them for stop and cleanup. Once a verdict (or triage's answer) is stored, its thread's worktree and branch are removed at once (`releaseRoleWorkspace`, only when unchanged, reason `review-finished`), not at the run's end; the thread and its messages stay. A thread with no valid answer keeps its worktree until the run's own cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-merge-lane.ts`                                     | What `merge` does after it holds the repository's lane (`merge:<repo>:<base>`, limit 1, applied to every merge node by `factory-flow.ts`): while the head is behind its base, GitHub's update-branch merges the base in and the checks are waited on again; a head made this way keeps the review of the commit it was made from when it is exactly a merge of it with the base. A conflict, or checks failing on the updated branch, ends `merge` with `outcome: sent_back` and feedback for the implementer (the merge loop goes back to `address`); any other failure fails the step and the run waits for a person.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-parent-close.ts`                                   | An issue whose work went to other issues (its run ended `done` with `triage.splitInto` or `triage.existing`) stays open, and the issues it blocks wait on it as `blocker-in-progress`, never `blocker-failed` (`delegated` in `factory-dependencies.ts`). Each watcher pass reads those runs' parts; once every part is closed it comments on the issue, closes it as completed (a `factory.close_parent` activity) and records `triage.partsClosedAt`, so the run is not read again. An issue a person closed first is only marked; a part that cannot be read, or a close GitHub refuses, is read again next pass. The board keeps such runs in **Waiting on parts** until their parts finished or the marker is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-triage.ts`                                         | Triage (the `triage` step, first in both built-ins): a read-only agent on its own thread answers `ready` with the run's contract (acceptance criteria, likely paths, risk hints; `factory_runs.triage`), or `needs_info` / `too_big`, for which the server posts one templated comment (five items of 300 characters, mentions and links removed) and parks the run in `needs_info` without a slot. With the factory's `tooBig: split` setting, a `too_big` answer instead opens each part as an issue (`splitPartIssue`: the part, the parent's description, the `SPLIT_MARKER`), queues them with the run's flow, comments the list on the parent, takes the factory's label off it and ends the run `done` (`triage.splitInto`); a part is never split again by itself, and nothing opened falls back to the comment. Without that setting a member can still split a parked `too_big` run from its card (**Split into N issues**, `factory.splitRun`, `split` in `factory-run-control.ts` → `splitParked` in `factory-flow-runs.ts`): the stored parts are opened the same way (`openSplitParts` / `announceSplit`, shared with triage), no agent runs, and the run moves `needs_info` → `done` by compare-and-set; parts an earlier attempt opened are not opened again. `already_done` (what the issue asks is already true of the code) and `not_actionable` (no change to the repository would fix it: a client's network, a service it does not configure) post the agent's evidence in the same template, close the issue (as completed / as not planned) and end the run `done`; an issue that cannot be closed parks the run in `needs_info`. No valid answer twice: the run goes on without a contract. A ready run whose likely paths overlap a run changing files (or one triaged `ready` and still `triaging`) goes back to the queue with `wait_reason` `paths-overlap`, keeping its contract; recording the contract and that check run one at a time per factory, so two triages that end together see each other. The hold stores the contract marked `heldForPaths` in the same write; when the run is admitted again and a run that changed those paths merged into its base meanwhile (`mergedPathsSince`), triage runs again on a new thread against the merged code, so a duplicate ends `already_done`. The mark is cleared once decided, and a `fromSpec` contract is never replaced. The watcher sends a `needs_info` run back to the queue when its issue's `updated_at` passed the triage time (`retriageAnswered`), as does Retry; the old answer is kept marked `superseded`. |
| `factory-sentinel.ts`, `factory-incidents.ts`               | The sentinel, run from each factory's tick (`superviseBase`): with a factory merge in the last 24 hours and the base branch red, it opens one incident per repository and base branch (`factory_incidents`, a compare-and-set insert), starts a read-only sentinel thread with the recent merges and the failing checks, and pauses the admissions of every factory on the repository (the reason is the factory's `blockedReason`; the settings carry the incident). The sentinel names a merge: the server opens a revert pull request and tells that run's enabler; anything else: every affected enabler is told. A revert is never merged by the factory. The incident closes when the base branch is green again, or by a member (`factory.closeIncident`, `steer`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `factory-role-results.ts`                                   | Reads a read-only role's structured result (see Role results): the last fenced `json` block of the thread's final message, validated against the role's schema, with one request to emit it again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `factory-run-control.ts`, `factory-follow-ups.ts`           | Stop, retry, take-over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-thread-requests.ts`                                | Stop / follow-up to a run's threads, routed by the thread's path (`withRunnerFor` `request` target), waking a sleeping sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `factory-sandbox-launch.ts`                                 | Starts a thread in the enabler's sandbox (the `thread-sandboxes` launcher, `source: 'factory'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `factory-pull-requests.ts`, `factory-ci-actions.ts`         | CI verdict (green / red / conflict / timeout, `required_checks`) and merge only on green (checks still running are waited for, up to 15 minutes, then the merge is tried again), with the App token capped by the enabler (`accessCapToken`); a merge pinned to a SHA (`sha`) is direct, and enables auto-merge only when GitHub holds `funny/regression-proof` pinned to this App (`isCheckHeldByApp`); publishes the proof's check with a checks-only token (`issueCheckPublisher`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `factory-integrate.ts`, `runtime/services/factory-steps.ts` | Factory steps on the run's runner (`POST/GET/DELETE /api/threads/:id/factory-steps`), in the implementing thread's checkout, never on the server: a flow's `run_command` (10 min unless the step sets up to an hour, no `cwd`, output masked and kept to 64 KiB) and `integrate` (see step 4b). A step the runner lost is not started again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `runtime/services/regression-proof.ts`                      | The regression proof job on the enabler's runner (`POST/GET/DELETE /api/threads/:id/regression-proof`): head checkout twice, then base checkout, both temporary and prepared alike; verdict `pass` / `fail` (`failureKind` `test` / `environment`) / `skipped`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## A run

0. **Queue** (sent issues): a send writes one `requested` row per accepted issue, with the chosen
   flow (`flow_name`) and a `queue_order`; issues sent together go oldest first. `requested` holds
   no slot and no flow drives it. A send is refused as a whole when the factory is paused or
   cannot work now (409, with the reason), and per issue when it is closed, a pull request,
   missing, or already in the factory.
1. **Admit**: in automatic mode each tick first records the open labelled issues that may run and
   have no run yet as `requested` rows (`source = 'label'`, behind the queue, oldest first), so
   the board's Queue shows everything that waits; one that lost its label (or every labelled one,
   once the factory is manual) leaves the queue. Then it fills `maxConcurrent − slot-holding
   runs` from the `requested` runs in queue order (compare-and-set `requested → queued`); the runs
   admitted in a round start together, and a launch that fails gives its slot to the next round.
   The tick's count is only a first guess: every write
   that puts a run in flight (admit, Retry, take-over) re-checks the cap in the
   same step (`withFreeSlot` in `factory-runs.ts`: serialized per factory in-process, and on
   Postgres in a transaction holding an advisory lock on the factory), so a Retry during the
   tick's GitHub reads cannot push the factory over `maxConcurrent` (#328). An issue whose blockers are unfinished is skipped,
   with its `wait_reason` recorded, and the next one is tried. A blocker is finished when its
   issue is closed or it has a merged run in this factory; an unreadable blocker list blocks for
   that tick. A partial unique index (migration 098) allows one non-terminal run per issue, so a
   queued issue cannot be sent or labelled into a second run.
2. **Agent steps**: the first is a new thread on the enabler's runtime (a worktree on their runner
   via `startThreadOnRunner`, also when their runtime is `local`, so an unattended agent never
   works in their own checkout; or their sandbox). Every later agent step (e.g. a CI fix)
   **continues that thread** with a follow-up message, so the agent keeps its context. When the
   agent cannot resume that session (`Session resume failed (0 turns)`, read from the thread's last
   `agent:error`), the step sends the message once more: the runner cleared the session, and the
   new turn carries the thread's history in its prompt (`resendAfterLostSession`). The agent
   commits, pushes the run's branch (`factory/issue-<n>-<runId8>`) and opens the PR; the server has no
   checkout. A worktree thread is created on that branch (the launch passes `branch`), so the
   thread, its worktree and the PR share one branch. A new branch starts from the remote's copy
   of the repository's DEFAULT branch, fetched first (the launch passes `baseBranch` and
   `baseFromRemote`; `createWorktree`'s `fromRemote`), so the PR holds the agent's commits only:
   not the branch the enabler's checkout is on, nor their unpushed commits. A default branch that
   cannot be read fails the step. A factory may name another branch to merge into
   (**Settings > project > Factory > Merge into**, `factory_settings.base_branch`, migration 132):
   the GitHub side reads it for the enabler (`factoryBaseBranchOf`, passed to
   `createFactoryRepoReads`), so `defaultBranch()` answers it and every user of the base
   (worktree start, `branchAhead`, `integrate`, stacking's retarget, the merge lane, the sentinel)
   follows. The base is decided once per run, when it is admitted, and recorded on it
   (`factory_runs.base_branch`, migration 137; `baseBranchFor` in `factory-watcher-admission.ts`,
   written inside `runs.admit`, and only the first time). The run's steps read it through
   `runReaderOf(scope)`, whose reader carries `baseBranch`, and `readerBaseBranch` prefers it over
   the factory's setting: a later change of **Merge into**, a retry or a restart does not move a
   run to another branch. A read with no run (the queue's flow checks, the sentinel) still gets
   the factory's setting, and a run from before migration 137 has none recorded and follows the
   setting. Flows and prompts are still read from the repository's default branch. `create_pr`
   retargets a pull request the agent opened against another branch (`retargetIfMisdirected`),
   and stops the run when it cannot. If the branch exists already (a retried
   run), the worktree checks it out and the agent goes on from the earlier attempt
   (`worktreeBranchName`, `createWorktree`'s `reuseExistingBranch`); only when another worktree
   still holds it does the runner fall back to a name from the title. The factory sends
   `requireBranch`, so for its threads that fallback is a 409 naming the worktree that holds the
   branch ("The agent could not start: …"), never a thread on another branch. A retry first frees the
   branch (`freeRunBranchForRetry`, reason `factory-retried`): it removes the worktrees of the
   threads it replaces and of any idle thread still on the run's branch, keeping the branch itself,
   and only when nothing would be lost (`remove-unchanged`). A worktree it cannot remove (unsaved
   work, runner offline) refuses the retry with its path, instead of starting a run every step of
   which would be refused. A kept first thread must be on the run's branch, else the retry starts a
   new agent. Each follow-up step sends
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
   1a. **Triage** (the `triage` step, first; change `factory-agent-roles`): see `factory-triage.ts`
   above. The contract goes to the implementing agent's first prompt
   (`{{triage.json.contract}}`), to the reviewer in place of the issue, and its risk hints to
   the risk class. The tick that admitted the run waits for its implementing thread at most
   `ADMIT_WAIT_MS` while triage runs.
   4a. **Review** (the `review` step, after `wait_ci` in `issue-to-merge`; change
   `factory-agent-roles`): a second agent, the **reviewer**, judges the PR's head commit on its
   own new read-only thread and answers `pass` / `fail` with findings (see Role results). It
   never gets the implementing thread, and the server builds its prompt. It starts when the
   commit's checks start (`wait_ci` is told about the step; `early: false` turns that off) and
   the step takes the stored verdict, waits for the review in flight or starts one; a review of
   a replaced commit is stopped and dropped. A `fail` with a `critical` or `high` finding loops
   back to `address` (the implementing agent's follow-up with the findings), then proof, CI and
   review run again on the new commit: three reviews, then the loop is exhausted and the run
   waits for a person. Each verdict is posted on the PR as a review with the event `COMMENT`
   and, when the installation accepted `statuses: write`, as the `funny/review` status.
   Invariants: only the implementing agent writes to the branch; no agent merges, approves or
   publishes; a verdict holds for one commit.
   4b. **Integrate** (the `integrate` step, after `create_pr` and at the start of both loops in
   `issue-to-merge`; change `factory-integration`): the runner merges `origin/<default branch>`
   into the run's branch (a merge, never a rebase), with `rerere` and, when `weave-driver` is
   installed, weave as the merge driver, both through `GIT_CONFIG_*` in the environment so
   nothing is written to the repository's config (the factory's writing agent threads get the
   same, `agent-startup/factory-git.ts`). A branch that already has its base is left alone.
   A conflicted path matching a regenerator of `.funny/integrate.yaml` (read from the default
   branch at the flow's commit; a file that does not validate fails the load and shows in
   Validate flow) takes the base's side and is rewritten by its command. Then the declared
   `checks`, the merge commit and the push; a failing check resets the branch. A conflict left
   is aborted: `outcome: conflict` with the paths and the base's diff of them goes to `address`.
   Review freshness: a merge that settled nothing (no path changed on both sides, nothing
   regenerated) keeps the review and the proof of the commit before it; one that settled
   something is reviewed again, the reviewer told to judge only the settled paths
   (`git show --remerge-diff`). `merge`'s sent-back round starts again at `integrate`, so a
   conflict it can settle never reaches the agent. The merge loop has 10 rounds; the third
   round that would reach the implementing agent (an integration conflict, or checks failing on
   the new base) parks the run (`merge rounds spent`). Counters: `integrateRounds`,
   `conflictsResolvedWithoutLlm`, `conflictsSentToAgent`, `mergeRoundsToAgent`.
   4c. **Merge queue** (change `factory-integration`, D2-D3, D11-D12): the merge group batches
   (`batch: { max, wait }` from the factory's setting, default 5 pull requests and 60 s; size 1
   is one at a time). The run whose `merge` gets the slot leads the batch the gate gathered
   (`factory-merge-batch.ts`, `factory-batch-leader.ts`, `factory-merge-queue.ts`, rows in
   `factory_batches` / `factory_batch_attempts`, `factory-batches.ts`). It re-checks each member
   from its own run row (a passing review, an accepted risk and a passing proof for the head it is
   tested at), keeps members whose changed paths do not overlap, builds the batch from base B on
   `factory/staging/<id>` with `[skip ci]` merges through the merges API, points
   `factory/queue/<id>` at a tree-identical commit, and waits for the base's required checks, or
   the checks the members' heads reported (none is never green). Green, with the base and every
   head unchanged: each pull request merges in order with its own enabler's token, pinned to the
   tested head, and the base's tree is compared with the tested one. A moved base or head rebuilds
   the batch; a refusal after a landing is a partial landing (the rest wait again, and a branch
   whose up-to-date rule could not be read gets batches of one from then on). Red: the same tree
   once more (a flake), then halves from B in parallel, every red half split again; culprits go
   back to their loop with the failing checks (a culprit back at the same commit, its agent having
   changed nothing, waits for a person instead of entering another batch: `culpritAt` in
   `factory-batches.ts`), the rest are requeued; no red half: one at a time,
   in order. A member is settled with the output its own `merge` would have had
   (`merge.json.outcome`), and a landed one is recorded `merged` on its own run. Every write about
   a member uses its enabler's capped token (`integrationFor`, `@funny/core/github-app`
   `createGithubIntegration`). The serial path stays where GitHub's merge queue is required,
   where pull requests must be up to date, where CI does not run on pushes to
   `factory/queue/**` (read from the default branch's workflows, `factory-readiness.ts`, or
   learned from a batch that got no check), and for a regenerable change (`merge.regenerate`,
   D9: a conflict re-runs that node, `regenerate_node` on the run). The merge group grants a
   blocker first, then a much smaller change (powers of four of its changed lines, recorded with
   the risk), then admission order. **Settings > Factory** shows the merge queue's batch setting
   and how the repository merges now, with what to change (`factory.readiness`): the merge
   driver the enabler's runner used at the last integration (`weaveIntegrations` on the run's
   metrics), the median CI time of the queue's last batch attempts against the batch wait
   (`ciDurations` in `factory-batches.ts`), and advice that never blocks a batch. Where CI does not
   run on the queue's branches it offers `factory.proposeQueueCi`: an issue, opened with the App
   token capped by the person who asked, sent to the factory as a normal run, so the trigger is a
   pull request the factory opens; nothing edits a workflow or a branch rule.
   4d. **Early integration and stacking** (change `factory-integration`, D8, D10): each tick
   that finds the base moved asks, for every run whose changed paths (its risk record's, or its
   contract's likely paths) overlap what merged, whether its pull request still merges, and runs
   `integrate` on the ones that do not (`factory-early-watch.ts`, at most every ten minutes per
   run). Steps that work in a run's checkout (agent steps, commands, `integrate`) hold its
   workspace lock (`factory-early-integration.ts`): asked while one does, the integration is
   pending (`integration_pending_at`) and runs before the next step; a run at merge is left to
   the queue; a conflict goes to the implementer at once. With `dependencies: stack` (factory
   setting, default `wait`), an issue whose one blocker is in flight with a pull request starts on
   the blocker's branch and opens its pull request against it (`stacked_on`, the prompts'
   `{{stack_branch}}`; its merge group stays the base's; a repository flow whose prompts never use
   it gets a warning in Validate flow, `staleStackingIssues` in `factory-flow.ts`). It waits for the blocker at the end of
   `ci` (never inside `merge`, whose slot is the blocker's way in), parks when the blocker ends
   without merging, and at `merge` is retargeted to the default branch and sent round to
   `integrate` first (`factory-stacking.ts`). Each push to the blocker's branch integrates the runs
   stacked on it, so a squash merge of the blocker does not conflict with them.
5. **Merge**: one at a time per repository and base branch (the lane, `factory-merge-lane.ts`).
   On entry, whatever path led to it, `merge` checks: the head commit has a verdict of the
   flow's own `review` step that allows a merge (unless `require_review: false`; an external
   bot's check or approval is not a review), the branch still contains the commit reviewed
   before it, and the risk class is one the factory merges by itself (`auto_merge`: `low_risk`
   by default). Otherwise the run waits for a person with the reason (`no review`,
   `review failed`, `high risk`, `branch history rewritten`). Then it brings the branch up to
   date with its base (update-branch, checks again) or, where the base requires GitHub's merge
   queue, enqueues and follows; a conflict or checks failing on the current base end the step
   with `outcome: sent_back` and the merge loop goes back to `address`. Unless
   `merge.require_regression_proof: false`, the merge reads the PR head and
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
   default branch, the run comments the agent's last message on the issue and removes its
   worktrees (the flow stops there). With nothing left behind the run ends as `no_change`, a
   terminal state that is not a failure: the issue is not closed ("nothing to change" is the
   agent's opinion) but handed back to a person, its factory label swapped for `needs-triage`
   (`relabelIssue`), nobody is notified, and the label does not admit the issue again
   (`endedWithoutChange`); Retry starts a new agent. A worktree with uncommitted files or
   commits only its branch has is kept and named in the comment, and the run parks
   `waiting_human` with reason `no change` instead: the runner checks and removes in one
   request (`POST /api/worktrees/remove-unchanged`), and a runner that cannot answer leaves the
   worktree in place and counts as kept.
   **A finished turn is not a finished agent**: a `completed` thread with a background job
   still running or a watcher pending (or one that ended in the last 2 minutes, whose wake is
   starting) still counts as running (`awaitsWake` in `factory-thread-waits.ts`), so the flow
   does not move on while the agent waits for its own tests.
   **A written answer is not always a finished turn**: the Claude CLI does not end a turn while
   a shell job it put in the background still runs, and in the read-only sandbox a bare `wait`
   never returns (it also waits for the sandbox's own proxies). The triage and review threads
   are waited on with `quietAnswerMs` (`ROLE_QUIET_ANSWER_MS`, 10 min): a `running` thread whose
   newest message is an answer (text, no tool call) that nothing followed for that long is
   `idle`, and `roleThreadWait` stops it and reads that answer as the role's result (metric
   event `role_turn_unclosed`). Their prompts also carry `READ_ONLY_SHELL_RULE`
   (`factory-role-results.ts`), as does the sentinel's, which already gives up after its own
   timeout.
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

## Triggers and runs without an issue

A run records the **trigger** that started it in `factory_runs.source`: `manual` (an issue
sent to the queue), `label` (a labelled issue, automatic mode), `schedule` or `run_now`. The
last two have no issue (openspec `flow-triggers`): `issue_number` is `0` in the database and
`issueNumber: null` everywhere else (`factory-runs.ts` is the only reader of the column), the
branch is `factory/run-<id>`, and the flow's inputs are the values the trigger recorded in
`factory_runs.inputs` instead of the issue's.

- **Which flows may run without an issue.** `validateFlowForIssuelessRun`
  (`factory-flow-validation.ts`) refuses a flow that has a `triage`, `review`,
  `regression_proof` or `merge` step, or that requires an input nobody supplies (the
  factory supplies `repo`, `branch`, `base_branch` and `factory_id`, and they always win
  over a recorded input of the same name). It runs when a schedule is saved, on "Run a
  flow", and again at the start of every run (`factory-flow-runs.ts`), since the flow is
  read from the default branch each time. The action provider refuses those four steps
  again for a run without an issue. So such a run can open a pull request and never merges
  one by itself.
- **Schedule triggers** (`factory-triggers.ts`, table `factory_triggers`): a name, a cron
  pattern, a flow, input values and an enabled flag, saved with `steer` through
  `factory.saveTrigger`. On each tick of an enabled factory, `queueDueTriggers`
  (`factory-watcher.ts`) takes every due occurrence with a compare-and-set on `next_run_at`
  (one server instance wins), then queues a run in `requested`; `admitWork` admits it under
  the factory's cap like a sent issue. An occurrence more than five minutes late (the
  server was down, the factory paused) is dropped, not run late.
- **One working run per trigger.** The partial unique index
  `factory_runs_one_active_per_trigger` refuses a second run while one is queued or in
  flight; the watcher then records a `factory.trigger_skipped` activity. A run parked for a
  person (its pull request is open) does not hold its trigger.
- **How it ends.** With a pull request it parks in `waiting_human` like an `issue-to-pr`
  run and closes when a person merges or closes the pull request. Without one it ends in
  the terminal state `done` (an issue run still ends `no_change`).
- **Run a flow** (`factory.runFlow`) queues one such run now; it is refused, like a sent
  issue, while the factory is paused or cannot work.
- Input values are written by a member with `steer`, are shown to every member who sees
  the factory, and are interpolated into prompts: they must not hold secrets. A name the
  factory supplies, or one `validateSecretName` reserves, is refused.

## Agent step options

Each agent step of a factory flow (a `spawn_agent` node, a retry's `before_retry` fix step)
runs with its own options (change `factory-flow-step-options`). One pure rule decides them,
`resolveStepOptions` in `factory-step-options.ts`, used by runs and by Validate flow alike:

- **Fields:** `provider`, `model`, `effort`, `permission_mode`, `allowed_tools`,
  `denied_tools`, `thread`, and `prompt` or `prompt_file`. Any other field (`agent`,
  `output_format`) refuses the flow when it loads, naming step and field
  (`validateFactoryFlow`, `factory-flow-validation.ts`), as do permission modes other than
  `autoEdit` and `plan`, tool lists on a provider that does not apply them (only `claude` and
  `pi`, `TOOL_POLICY_PROVIDERS`), and a model the provider does not have
  (`providerModelProblem`, the runtime's own rule, in `@funny/shared/models`).
- **Precedence**, per field: the factory's step override (provider, model, effort only), the
  step, the flow's `defaults:`, the project's defaults, then the factory's (`DEFAULT_PROVIDER`,
  the provider's default model, `autoEdit`). A model counts only on the provider it runs on, so
  an override of the provider alone does not keep another provider's model. Provider, model and
  permission mode are always sent explicitly: the runtime keeps them on the thread, and a step
  that set none must not run on the previous step's.
- **Where they go:** the first step's thread-create body, and every later step's follow-up body
  (`sendFactoryFollowUp`). A model or provider change on a continuing thread resets its agent
  session and replays the transcript; Validate flow warns about it.
- **Step ids:** the node id, or `<node>.before_retry` for every attempt of a retry's fix step,
  so one override covers them all.
- **`thread: new`:** the step runs on a thread of its own instead of continuing the
  implementing one: titled `[Factory <step>] #N …` (so an interrupted launch is adopted by its
  own title), not on the run's branch, started `readOnly` (the runner holds it to reading), so
  it must resolve to `plan` and to a read-only provider (`claude`, `codex`), and it cannot be the
  first agent step. Its output reaches later steps as `{{<step>.output}}`. It is recorded in
  `threadIds`, so stop stops it and a resumed run waits on it instead of starting another.
- **Prompt files:** `prompt_file: prompts/x.md` is read relative to the flow's directory
  (`resolvePromptFiles`, `@funny/workflows`; absolute paths, `..` and backslashes refused): for a
  repository flow from the default branch at the same commit as the flow, for a built-in from
  `packages/workflows/defaults/prompts/`. The text is templated like an inline prompt.
- **Overrides** live on the factory (`factory_settings.step_overrides`, saved with `steer`,
  strict contract `factoryStepOverridesSchema`) and are read again at every agent step, so a
  change reaches the steps not started yet.
- **Recorded:** a run stores where its flow came from (`flow_source`, `repository` /
  `built-in`), the default-branch commit it was read at (`flow_commit`; written on the first
  start and on a retry, kept on resume), and every agent step's resolved options
  (`step_options`).
- **Validate flow** (`factory.validateFlow`, `view`, `factory-queue.ts`): loads the flow exactly
  as an admitted run would and answers every problem, or the steps by kind, each agent step's
  resolved options and thread, the overrides that name no agent step, and context-replay
  warnings. It starts nothing.

## The spec stage

Openspec `factory-spec-stage`, off by default (**Spec stage** in the factory's settings,
`factory_settings.spec_stage`). With it on, triage may answer a fifth way, `needs_spec`: the issue
is workable but leaves **product decisions** open that a wrong guess would waste (where an
affordance lives, what it applies to, its edges). Its answer names the open decisions and what
triage learned in the code. Off, the answer is invalid (`triageResultSchemaFor`), so a factory
never parks on an answer it did not opt into.

- **Park and start a writer.** The run is written `needs_spec` (from `triaging` only; no slot,
  holdable, stoppable) and nothing is posted on the issue. The server starts a **spec writer**
  (`factory-spec.ts`): a read-only role thread of the enabler titled `[Factory spec] #N <title>`
  (adopted by title on resume), given the issue, triage's decisions and findings, and on a reopen
  the spec approved before, as role inputs (never inlined in its prompt). Its thread is recorded
  as `factory_runs.spec.threadId` and is among `threadsOf`, so a stop reaches it. Its worktree is
  kept while the run is `needs_spec` and released on approval, retriage, hold and stop.
- **The conversation is a funny thread.** Members answer by following up on the spec thread.
  Each completed turn (`onFactoryThreadTerminal` → `onFactorySpecTurn`; no flow runs) is read with
  `readRoleResult(factorySpecResultSchema)`: `questions`, or a `draft` (summary, decisions with
  their answers, behavior, approach, out of scope, a validation checklist of at least one item,
  and the contract). The latest valid result is stored with the next `revision` and the enabler
  gets a Web Push; no valid result after one re-emit request stores `problem` and the run stays
  parked. A follow-up on the spec thread never takes the run over.
- **A member approves.** `factory.approveSpec({ runId, revision })` (`steer`, browser session
  only; `factory-runs-spec.ts`) writes, in one compare-and-set from `needs_spec` and the spec as
  read, `spec.approved` (who, when, revision), a `ready` triage with the draft's contract and
  `fromSpec: true`, and `requested` with the run's earlier `queue_order`. A newer draft or a run
  that moved answers 409 and the board reads the runs again. Audited (`factory.spec_approved`) and
  recorded as an activity. `factory.reopenSpec` drops the approval, writes `needs_spec` from
  `requested` or a parked state (refused in flight) and asks the kept thread for a revision, or
  starts a new writer given the approved spec when that thread takes no follow-up.
- **The spec binds the implementer and the reviewer.** A `fromSpec` triage is replayed, never
  superseded by an issue edit (`issueChangedSince`), and kept on a release from hold. The flow gets
  `{{spec}}` (the approved spec as Markdown) and `{{spec_commit_path}}` (`<Commit spec>/issue-N.md`
  when the factory's **Commit spec** setting names a folder) as inputs (`specInputsOf`); the
  built-in `implement.md` says the spec's decisions are fixed and open choices go under
  **Decisions** in the pull request. Validate flow warns when the Spec stage is on and a
  repository flow's first agent prompt never uses `{{spec}}`. The reviewer gets the validation
  items and must answer each in `checklist` (an item left out is an invalid result); each item
  not met is added as a `high` finding and turns the verdict into a `fail`
  (`withChecklistFindings`), so it loops back to the implementer; the pull request's review
  comment lists the checklist.

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
- **Approve / Reopen spec** (`factory.approveSpec`, `factory.reopenSpec`): see
  [The spec stage](#the-spec-stage). Retry on a `needs_spec` run triages it again.
- **Stop** (`factory.stopRun`): the run is `stopped`, its flow stops and its running threads are
  stopped on the enabler's runner. A thread whose launch raced the stop is stopped when recorded.
  A run the factory took by its label has that label taken off its issue (`releaseStoppedIssue`
  in `factory-run-control.ts`), so automatic mode does not admit it again; putting the label back
  admits it. Removing a labelled issue from the queue, or **Clear queue**, does the same.
- **Superseded pull requests** (openspec `factory-close-superseded-prs`): stopping a run leaves
  its pull request open, so a member can take it over by hand. Once another run of the same issue
  is recorded `merged` (by its flow, the merge queue, or a person on GitHub), the factory closes
  the pull requests of that issue's `stopped` / `failed` runs (`factory-superseded.ts`, called
  from `closeSupersededFor` in `factory-watcher-state.ts`): a comment naming the merged pull
  request, the close and the branch deletion, through the same `closeReplaced` a member's
  `factory.closeReplacedPr` uses, recorded as a `factory.close-pr` activity with origin `system`.
  It leaves a pull request open when it is not open any more, or when its head is not a commit the
  factory recorded for that run (reviewed, classified, proved or approved): somebody pushed to it.
  Runs come from the factory's rows, never from a branch search.
- **Retry** (`factory.retryRun`): a `failed` / `waiting_human` run goes back in flight on the same
  branch and PR; a completed implement step is kept, later steps run again. While the factory
  already runs `maxConcurrent` runs it goes to the head of the queue instead (`requested`, wait
  reason `no-free-slot`, the same steps to replay) and the watcher admits it at the next free
  slot; a merge approval and a take-over do the same (`reopen` in `factory-runs.ts`). A `no_change` run (or one parked with reason `no change`)
  keeps nothing (replaying its thread would only reach `no change` again): a new agent starts.
  The threads the retry does not keep are archived (unless one is still running), so the list does
  not show the old failed thread next to the new one under the same title.
  The later steps run again but do not redo what holds for an unchanged head: the review step
  keeps a stored verdict of the head commit, and the proof step keeps the run's stored passing
  proof of it (`reusedProof`, event `regression_proof_reused`).
- **Split** (`factory.splitRun`): a run parked because triage found its issue too large is
  split into the parts triage proposed, without an agent and whatever the factory's `tooBig`
  setting (see `factory-triage.ts` above). Audited as `factory.run_split`, shown as a
  `factory.split` activity.
- **Merge approval** of a high-risk change (`factory.approveMerge`): recorded for the held head
  commit only. The call carries the commit the member was shown (`expectedSha`) and is refused
  when the run is held on another one (openspec `factory-agent-tools`). When the base is merged into that commit and the merge settled nothing (the
  `integrate` step, or the merge lane updating the branch), the approval moves to the merge commit
  with its review and proof (`carryChecks` in `factory-action-provider.ts`,
  `carryMergeApproval` in `factory-runs.ts`, `carriedFrom` names the approved commit). Any other
  new commit needs a new approval.
  The hold is on a head that includes the base: before `merge` parks a high-risk change, it brings
  the base in (`heldOnCurrentBase`, the lane's `updateBase`) without waiting for the new head's
  checks, which run while the member decides. A conflict goes to integration first. Not where
  GitHub's merge queue is required (openspec `factory-approval-survives-integration`).
  The approval also follows the **same change** to any later commit: when the head is not the
  approved commit, the risk gate asks the run's runner for the change's delta (the factory step
  `change-delta`, `runtime/services/factory-change-delta.ts`: per file, the lines the pull request
  adds and removes against its base at the approved commit and at the head, without positions).
  A head that descends from the approved commit with a delta of zero is covered, whoever merged
  the base in and whatever that merge settled (`approvalCovers` in `factory-approval-carry.ts`);
  each move is kept in the approval's `moves`. A delta that is not zero, a rewritten branch, or a
  runner that cannot answer (offline, or from before the step) leaves the run waiting, with the
  reason in the hold message. The delta is always taken from the commit the member approved.
  A factory may also let the approval follow a **small adjustment** (`approvalAdjustMaxLines` in
  the factory settings, 0 to 200 lines, **0 by default: off**): the delta is at most that many
  lines, only in files the approved change touched, and the head's risk classification has no key
  the approved commit lacked. `classifyRisk` gives each reason a stable key (`size`,
  `sensitive:<path>`, `finding:<kind>:<path>`, `contract:<hash>`); approving stores them in the
  approval's `riskKeys`, and an approval without them follows only the same change. With the
  setting on the factory merges lines no person read: the review of the new commit is the
  remaining guard.
  An adjustment may also touch a file **the base brought** (openspec
  `factory-approval-follows-base-code`): the runner's `change-delta` step also diffs the base
  between the two commits' fork points, and reports in `baseBrought` the files outside the
  approved change that the base changed there and from which the change removes only lines the
  base added (the implementer fixing the base's new code, as a lint cleanup does after a base
  merge). `linesAcrossMoves` is the delta without the edits that moved with their code into such a
  file (a split by another pull request); the limit counts it. Moves between two files of the
  approved change still count. A runner that sends neither field leaves the file-by-file rule.
  The PR comment, the `factory.approval-moved` activity, the stored move and the gap list those
  files apart (`baseFiles`).
  When the approval does **not** follow, the hold keeps what differs instead of only a sentence
  (openspec `factory-merge-fewer-bounces`): `approvalGapOf` turns the same delta into the
  approval's `gap` (the held commit, the lines that differ, at most 20 files, the ones the
  approved change did not touch, the risk keys that are new, the reason), written by
  `noteApprovalGap` with a compare-and-set on the stored approval. `approvalGapFor(approval,
  heldSha)` (`@funny/shared/contracts/factory`) reads it only for the commit it is about. The
  approval card in the thread, the run panel, the board card ("Asks again after N lines
  changed") and `funny_factory_runs` show it (`ApprovalGapNote`), so a second approval costs the
  reading of the difference. The approval is still given for the whole held commit; a new
  approval replaces the record, so later adjustments are measured from the commit just approved.
  **A merge GitHub refuses** is told apart by which branch moved (`movedSince` in
  `factory-merge-lane.ts`): the head, the base (the head is behind it), or neither. With a branch
  moved the run goes back through `upToDate` (base in, checks, proof, the approval re-decided)
  and merges again, without parking; `MAX_STALE_MERGES` (3) such refusals in one visit to
  `merge` park it as `base keeps moving`. With neither moved it parks with GitHub's own message,
  which `pinnedMerge` now keeps next to the status. Seen on #450 (2026-11-25): a push to the base
  two seconds before the merge got a 405 and a run waiting for a person.
  **Lint cleanups.** Triage classes a run as a lint cleanup, never a member: its contract's
  `lintCleanup` and `lintRules`, the rules the issue asks to clear as the linter names them. The
  class holds only when every named rule is in `BEHAVIOR_NEUTRAL_LINT_RULES`
  (`@funny/shared/contracts/factory`: `max-lines`, `max-lines-per-function`, `max-statements`,
  `max-depth`, `max-nested-callbacks`, `sort-imports`), rules whose fix moves code without
  changing what it does. A cleanup of a type, validation, effect or style rule is classed like any
  change: #484 (`no-unknown-parameters`) narrowed a request schema, which its review caught. With
  the class, `classifyRisk` sets aside the size reason and the contract's risk hints (kept in the
  risk's `waived`), provided `lintCleanupRefusals` finds, in the diff alone, no added suppression
  (`eslint-disable`, `oxlint-disable`, `@ts-expect-error`, …; one removed with the same text, a
  suppression moved by a file split, pays for one added), no change to a lint or type-check
  configuration file, and no code file GitHub gave no patch for. Otherwise nothing is waived and
  the reason says why. Weakened tests and sensitive paths hold whatever the class. The check shows
  the warnings were not hidden, not that the change does nothing else: tests, review and proof
  answer that. Triage is an agent that read the issue's text, so its class can be wrong or
  steered by that text; the rule list bounds what it can waive. A member can only veto it ("Not a
  lint cleanup", `factory.setLintCleanup` with `false`, stored as `risk_waiver.kind`
  `not-lint-cleanup`, migration 129) and take the veto back, which puts a run held for its risk
  back in flight. `lintCleanupSource` decides. A run triaged before `lintRules` existed has none,
  so it is not a lint cleanup.
  **No change.** A run that ended as `no_change` stays on the board for a person: the member can
  retry it, or agree with the agent through "Mark as done" (`factory.markRunDone`, a
  compare-and-set from `no_change` to `done`). The issue on GitHub is left as it is.
  **Paths.** A run that already has a pull request waits for no paths (`pathsHeld` in
  `factory-watcher.ts`, triage's `busyPaths`): it has no implementer to start, and queueing it
  behind later runs let them merge first. With the factory's `holdPathsAwaitingApproval` setting
  (off by default) a run parked for a member's approval keeps its likely paths for
  `APPROVAL_PATH_HOLD_MS` (12 hours); a run that waits only for such runs has the wait reason
  `paths-awaiting-approval`.
  Every move is announced (`announceApprovalMove`): a comment on the pull request that says it is
  automated and that no person approved the new commit, the activity `factory.approval-moved` of
  the member who approved, and the run detail's "Merge approved at … moved to …". A comment that
  cannot be posted is logged and does not stop the merge.
- **Take over**: when the thread's **owner** follows up on a parked run's last thread after it
  parked (noted by `POST /api/threads/:id/message`), the run resumes from that step when the thread
  completes (when the factory is full, the run stays parked; a later completion of the follow-up,
  or a Retry, takes it over once a slot frees). A steer sharee's follow-up never does: it would otherwise move the flow toward a merge
  in the enabler's name. The note is in memory; after a restart use Retry.
- **Lost access**: if the enabler loses `steer`, the factory is turned off and their open runs are
  stopped (`factory.disabled_access_lost` audit).

## From a thread's agent

An agent in a project thread reaches the thread owner's factory through three tools of the `funny`
MCP server (openspec `factory-agent-tools`, `runtime/services/agent-factory-tools.ts`):

| Tool                             | What it does                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `funny_factory_runs`             | Lists the owner's runs in the thread's project: state, wait reason, risk, approval, its request. |
| `funny_factory_control`          | Retries or stops one run, through the board's control. The activity row names the thread.        |
| `funny_factory_request_approval` | Asks the member to approve a held high-risk merge. It never approves.                            |

**An agent asks, a member approves.** The tools travel as three data-channel types
(`data:factory_list_runs`, `data:factory_control_run`, `data:factory_request_approval`, rule
`refs`). The server takes the actor and the project from the thread's row
(`factory-agent-tools.ts` in `server/services/factory/`), re-checks the owner's `steer`, and has
no path from this channel to `approveMerge` or `approveSpec`: the control's action type never
names an approval. On a `needs_spec` run with a draft, `funny_factory_request_approval` creates a
request of kind `spec` for that draft's revision (stored as `spec:<revision>` in the request's
`sha` column), which expires when the revision changes or the run leaves `needs_spec`; the member
answers it with `approveSpec` on its card in the thread (`FactorySpecRequestCard.tsx`: the
run's stored draft for that revision, Approve / Decline for a member with `steer`). `funny_factory_run` returns the run's spec (questions, draft,
problem) and its approval.

`factoryToolAccess` decides where the tools are refused: a sandbox thread or runner (also refused
by type in `data-scope.ts`, `NEVER_FROM_SANDBOX_TYPES`), a read-only thread, a scratch thread, and
a thread the factory started. In a thread shared at `steer`, only listing works. Each refusal is
audited (`factory.agent_tool_refused`) and answered to the agent as a tool error.

An approval request is a row of `factory_approval_requests`, bound to one run and one commit, at
most one pending per run. It carries no text: the card in the thread
(`FactoryApprovalRequestCard.tsx`, a timeline card placed at the time the agent asked, kept after
the answer with the run's current state) and the marker on the board read the run. Its states are
`pending → approved | declined | expired` (`factory-approval-requests.ts`): approving the run
closes it as approved, `factory.declineApprovalRequest` declines it and leaves the run held, and
it expires when the run is held on another commit or leaves the hold. The server brings a request
in line with its run when the run is approved, retried or stopped, when the agent asks again, and
whenever requests are read. The agent learns the outcome from `funny_factory_runs`.

The run list an agent gets holds no text written outside funny: no issue title, no review text.

## The factory view

`/factory` lists every run of the caller's factories, as a list (the default) or a board
(openspec `factory-pipeline-board`; the choice is kept in localStorage, `funny:factory-view-layout`).
The search, project and state filters and the **Active** filter (hides `merged`, `no_change`,
`stopped`) apply to both.

- **Columns** (`components/factory-board/board-columns.ts`) come from the run's `state`, never from
  its thread's stage (which folds every active step into `in_progress`): Queue (`requested`,
  `queued`), Triage, Implementing (`working`, `fixing`), PR · Proof · CI (`pr_open`, `waiting_ci`),
  Review, Merge, Needs a person (`needs_info`, `needs_spec`, `waiting_human`, `failed`, `no_change`, and any state
  the client does not know) and Done (`merged`, `stopped`, only the last 24 hours; older ones are
  counted and left to the list).
- **Read-only**: there is no drag and drop. Only the server moves a run; the card carries the same
  PR / Retry / Stop controls as the list row.
- **Card**: the flow strip is `factoryRunSteps` (`lib/factory-run-labels.ts`) plus the review round
  and each agent step's provider / model / effort from `stepOptions`; the gate chips
  (`run-gates.ts`) are risk, the latest review (`factoryRunReviewLabel`), the regression proof and
  CI rounds, greyed when they are for an older commit than the head; the waiting line
  (`run-waiting.ts`) is the queue's `waitReason`, triage's questions, or the reason the server
  recorded in `failureReason` when the run parked or failed.
- **Limits**: with exactly one project selected, the Implementing and Review headers show the count
  against that factory's `stageLimits.implement` / `stageLimits.review` (else `maxConcurrent`), and
  Merge says one at a time per repository. Across projects there is no shared limit, so only counts
  show.
- The column layout is `components/board/BoardColumn.tsx`, shared with the thread kanban.
- **Clear queue / Stop all** (`components/factory-board/FactoryQueueActions.tsx`) sit in the
  toolbar and act on the projects the project filter keeps (every project with runs when it keeps
  all): one `clearQueue` / `stopAll` per project that has something to clear or stop. Stop all asks
  for a confirmation first.
- **Analytics layout** (`FactoryAnalytics.tsx`, the toggle's third layout, `?view=analytics`):
  the view's figures, as `MetricCard`s like the analytics view; the header shows none. First the
  health figures, then the integration figures.
- **Integration figures** (`FactoryIntegrationStats.tsx`, in the analytics layout): merge rate,
  time in the queue and to merge, CI rounds, red rounds, conflicts, agent fixes and merge queue
  batches, from `summarizeFactoryRuns` (`data/factory/metrics.ts`) over the filtered runs of the
  last 14 days (the view lists runs that ended within 14 days). The project settings no longer
  list runs or figures.
- **Run detail panel** (openspec `factory-run-detail`, `components/factory-board/run-detail/`): a
  board card, or a list row's details button, opens a side panel named by the `run` search
  parameter (`/factory?run=<id>`, `use-selected-factory-run.ts`), so it can be linked; an id that
  is not listed clears the parameter once the runs have loaded. It is a view of the listed run, so
  it follows it live: header with the run controls and why it stopped, the flow, triage's decision
  (contract, questions or split), the regression proof, one entry per review verdict with its
  findings, risk and CI, and every agent thread (`thread-links.ts`: triage, implementer, one
  reviewer per review). The list row's title still opens the run's thread.
- **Health figures** (`FactoryHealthHeader.tsx`, `factory-health.ts`, in the analytics layout):
  over every listed run, not
  the filtered ones: in flight, needing a person, merged in 24 h, and over 7 days the first-pass
  review rate, merge holds and median time to merge (7 days, because the queue lists ended runs
  for 14). Above the layouts, one banner per project whose factory has an open incident
  (`ProjectFactoryIncident`, the same banner as the project settings, read from each project's
  factory settings).
- **Step timings** (openspec `factory-step-timings`): the run lists (`factory.queueRuns`,
  `factory.runs`) carry `stepTimings`, each flow node execution (step, visit, attempt, status,
  start, end) read from the workflow journal `workflow_node_executions` in one batched query of
  its small columns (`services/factory/factory-step-timings.ts`); other answers that return a run
  leave it out. A card says how long the run has been in its current step, or waiting for it
  (no execution of the step yet: its slot, such as the merge lane); the panel shows a timeline
  with the waits between executions; the Triage to Merge column headers show the median time in
  the stage over 7 days, for the built-in flows' node ids (`step-stage.ts`). The engine writes an
  execution once its slot is granted, so a slot wait shows only as the gap before the step, and a
  run reopened from scratch has its journal, and so its timings, cleared.

## Lanes (parallel feature branches)

A factory can work on several long-lived feature branches in parallel (openspec `factory-lanes`).

- **Convention and two labels**: an issue joins a lane when it carries **both** the factory's own
  label (for example `ready-for-agent`, in automatic mode, or when sent manually) **and** a lane
  label matching `laneLabelPrefix` (default `lane:`, so `lane:<name>`; factories saved before
  migration 141 keep `feature:`). Carrying only `lane:<name>` without the factory label never
  admits the issue or creates a lane. The lane's branch is `<laneBranchPrefix><name>` (default
  `lane/<name>`); a branch that an active lane of another factory of the same project uses is
  refused with `lane-invalid` (`branchOfAnotherFactory`). Both prefixes live on
  `factory_settings` and are fixed while the factory has lanes, as is **Merge into**. Two lane
  labels park the issue in the queue with `lane-ambiguous`; an invalid name, a branch matching
  **Merge into** or the repository's default branch, or a branch GitHub cannot create parks it with
  `lane-invalid`.
- **Frozen base**: at admission, the server resolves the lane (`resolveLane`), creates the
  `factory_lanes` row and missing branch from **Merge into** if needed, inspects repository
  workflows for `pull_request` / `push` filters that exclude the lane branch (`ci_warning`), and
  freezes the branch on the run (`factory_runs.base_branch` and `factory_runs.lane`). Each lane
  holds its own merge concurrency group (`merge:<repo>:<lane branch>`), so two lanes merge in
  parallel.
- **Sync and merge-commit requirement**: `factory-lane-sync.ts` keeps active lanes up to date with
  **Merge into** (`idle → merging → checking | resolving → checking → idle`, with `needs_human` on
  unrecoverable errors or after three conflict-resolution attempts). The watcher starts a sync when
  **Merge into** has moved and at least an hour has passed since the last sync start (and **Merge
  into** has no open sentinel incident); a member can also trigger **Sync now** or **Retry sync**
  (`factory.lanes.sync`). Clean syncs open a `factory/sync/<name>` pull request into the lane and
  merge it with the **`merge`** method (holding `merge:<repo>:<lane branch>`) so git records both
  parents; if the repository disables merge commits, the sync moves to `needs_human` with the
  reason. Syncs do not consume issue-stage concurrency slots, and every transition records a
  `factory.lane_sync` activity.
- **Cross-branch dependencies**: `factory-dependencies.ts` checks whether a blocker merged on
  another branch (its `merge_sha`, read once from GitHub and stored on `factory_runs.merge_sha`) is
  already contained in the candidate's base branch. Until it is, the candidate waits with
  `blocker-on-other-branch`, and `factory-stacking.ts` never stacks across different base branches.
- **Closing a lane run's issue**: GitHub only auto-closes issues on merges into the default branch.
  When a run whose base is a lane branch merges, the server closes its issue and posts a comment
  naming the lane branch (unlaned runs are untouched; a refused close is recorded without failing
  the merged run).
- **Finishing a lane**: `factory.lanes.finish` (Settings > project > Factory > **Finish lane**)
  refuses while any run of the lane is in flight, starts a sync if the lane is behind, and opens a
  pull request from the lane branch into **Finish into** (`factory_settings.lane_finish_branch`,
  migration 145; empty: **Merge into**) listing the lane's merged issues with a note
  that a person merges it (`finish_pr_number`, `factory.finish_lane` activity). When the watcher
  sees that pull request merged, it marks the lane `finished` (compare-and-set from `active`),
  stops its syncs, and routes any later issue naming that lane to **Merge into**.
- **Finish into**: a lane still starts from and syncs with **Merge into**; only its final pull
  request targets **Finish into**. With **Merge into** `master` and **Finish into** `qa`, fixes cut
  from production collect on the lane and land on QA together. It is not fixed while lanes exist,
  and a lane's branch may not be it (`lane-invalid`). Issues without a lane label still merge into
  **Merge into**.
- **Branches chosen at the send** (D13): the send dialog's branches go with that send
  (`route` of `factory.submitIssues`, kept on the queued runs as `factory_runs.requested_route`,
  migration 146), never to the settings. Without a lane, the run's base is the chosen branch. For
  a lane the send makes, the lane is cut from the chosen **Starts from** and keeps it and
  **Finish into** on its row (`factory_lanes.base_branch`, `finish_branch`; null: the factory's
  settings): it syncs with its own base and finishes into its own branch, then the factory's
  **Finish into**, then its base. A lane that exists keeps its branches. A send naming a branch
  GitHub does not have is refused.

## Security boundaries

- Every thread, follow-up and stop is the enabler's, on their own runner or sandbox
  (`withRunnerFor`), never another user's.
- GitHub calls use the deployment's GitHub App token for the repo, capped by the enabler's own
  access; a read-level enabler cannot merge. A merge happens only on green checks and does not
  bypass branch protections.
- An agent never approves a merge. A thread's agent can retry or stop the owner's runs and ask for
  an approval; the approval itself needs the owner's browser session and names the commit shown.
- The flow is read only from the default branch; issue text is not inlined into prompts (the agent
  reads the issue by URL).

Possible improvements not yet implemented (orphaned-worktree sweep, sandbox runs, metrics, …) are
listed in [issue-factory-improvements.md](issue-factory-improvements.md).
