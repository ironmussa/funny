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
`ProjectFactoryRuns.tsx`, data in `data/factory/`) and the factory view (`/factory`,
`components/FactoryQueueView.tsx`), served over the `factory` tRPC group. See
[The factory view](#the-factory-view).

> Not to be confused with `packages/orchestrator`, the standalone issue factory that runs flows
> in its own workspaces with local git. It shares the GitHub logic (`@funny/core/github-app`)
> and the `factory-issue` flow; the server factory does not run that flow.

## Pieces

| File                                                        | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory-settings.ts`                                       | One row per (project, user): enabled (running / paused), `mode` (`manual` / `automatic`), label (automatic only), `flowName` (default `issue-to-merge`), `maxConcurrent`, `blockedReason`, per-step agent overrides (`step_overrides`). Save needs `steer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `factory-watcher.ts`                                        | One poll per factory (60 s; also paused factories with runs in flight). Per tick: re-check the enabler's `steer`, resolve runtime and repo, resume runs not driven in this process, then fill free slots: the queue in order, then (automatic) labelled issues; blocked issues are skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `factory-queue.ts`                                          | Sending issues (checked live: running, target resolves, flow loads, each issue open and not a PR), the flows a send may pick, the send bar's blockers, Clear queue and Stop all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `factory-dependencies.ts`                                   | Pure: whether an issue waits for its blockers (GitHub's "blocked by", read with `issueBlockers` from `@funny/core/github-app`) and why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `factory-flow.ts`                                           | Loads `.funny/workflows/<flowName>.yaml` from the repo's **default branch** at its head commit (contents API, App token), with its prompt files from the same commit, else the built-in; then refuses what the factory cannot apply (`factory-flow-validation.ts`, see Agent step options). `factory-issue` is refused (workspace-only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `factory-flow-runs.ts`                                      | Runs the compiled flow with `@funny/pipelines` and writes progress to `factory_runs`; decides how a run ends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `factory-action-provider.ts`                                | The server `ActionProvider`: agent steps are threads; `create_pr` finds the agent's PR by branch; `wait_ci` / `merge` via `factory-ci-actions.ts`; `run_command` and `integrate` run on the runner (`factory-step-runner.ts`, `factory-integrate.ts`); approvals refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `factory-thread-waits.ts`                                   | An agent step waits on the thread's persisted status, woken by `notifyTerminalStatusPersisted` and a 30 s DB poll; missing or > 24 h thread fails the step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `factory-test-weakening.ts`, `factory-risk.ts`              | Pure, no agent: what a pull request does to tests and CI (removed or skipped tests, lowered coverage thresholds, edited workflows), and its risk class (`high` on any such finding, more than 400 changed lines without lockfiles, or a sensitive path: `.github/**`, migrations, `auth/`, plus the factory's own list). `wait_ci` runs both once per head commit and stores the class on the run.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-review.ts`                                         | The reviewer: one new read-only thread per head commit (`permissionMode: plan`, write tools denied, never the implementing thread), a server-built prompt (commit, pull request, issue URL, the server's findings), the validated verdict stored per commit in `factory_runs.review_verdicts`. No verdict after one re-emit request parks the run (`review gave no verdict`). Review threads are not in `threadIds`; `threadsOf` (`factory-runs.ts`) adds them for stop and cleanup.                                                                                                                                                                                                                                                                                                                     |
| `factory-merge-lane.ts`                                     | What `merge` does after it holds the repository's lane (`merge:<repo>:<base>`, limit 1, applied to every merge node by `factory-flow.ts`): while the head is behind its base, GitHub's update-branch merges the base in and the checks are waited on again; a head made this way keeps the review of the commit it was made from when it is exactly a merge of it with the base. A conflict, or checks failing on the updated branch, ends `merge` with `outcome: sent_back` and feedback for the implementer (the merge loop goes back to `address`); any other failure fails the step and the run waits for a person.                                                                                                                                                                                  |
| `factory-triage.ts`                                         | Triage (the `triage` step, first in both built-ins): a read-only agent on its own thread answers `ready` with the run's contract (acceptance criteria, likely paths, risk hints; `factory_runs.triage`), or `needs_info` / `too_big`, for which the server posts one templated comment (five items of 300 characters, mentions and links removed) and parks the run in `needs_info` without a slot. No valid answer twice: the run goes on without a contract. A ready run whose likely paths overlap a run changing files goes back to the queue with `wait_reason` `paths-overlap`, keeping its contract. The watcher sends a `needs_info` run back to the queue when its issue's `updated_at` passed the triage time (`retriageAnswered`), as does Retry; the old answer is kept marked `superseded`. |
| `factory-sentinel.ts`, `factory-incidents.ts`               | The sentinel, run from each factory's tick (`superviseBase`): with a factory merge in the last 24 hours and the base branch red, it opens one incident per repository and base branch (`factory_incidents`, a compare-and-set insert), starts a read-only sentinel thread with the recent merges and the failing checks, and pauses the admissions of every factory on the repository (the reason is the factory's `blockedReason`; the settings carry the incident). The sentinel names a merge: the server opens a revert pull request and tells that run's enabler; anything else: every affected enabler is told. A revert is never merged by the factory. The incident closes when the base branch is green again, or by a member (`factory.closeIncident`, `steer`).                               |
| `factory-role-results.ts`                                   | Reads a read-only role's structured result (see Role results): the last fenced `json` block of the thread's final message, validated against the role's schema, with one request to emit it again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `factory-run-control.ts`, `factory-follow-ups.ts`           | Stop, retry, take-over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `factory-thread-requests.ts`                                | Stop / follow-up to a run's threads, routed by the thread's path (`withRunnerFor` `request` target), waking a sleeping sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `factory-sandbox-launch.ts`                                 | Starts a thread in the enabler's sandbox (the `thread-sandboxes` launcher, `source: 'factory'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `factory-pull-requests.ts`, `factory-ci-actions.ts`         | CI verdict (green / red / conflict / timeout, `required_checks`) and merge only on green, with the App token capped by the enabler (`accessCapToken`); a merge pinned to a SHA (`sha`) is direct, and enables auto-merge only when GitHub holds `funny/regression-proof` pinned to this App (`isCheckHeldByApp`); publishes the proof's check with a checks-only token (`issueCheckPublisher`).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `factory-integrate.ts`, `runtime/services/factory-steps.ts` | Factory steps on the run's runner (`POST/GET/DELETE /api/threads/:id/factory-steps`), in the implementing thread's checkout, never on the server: a flow's `run_command` (10 min unless the step sets up to an hour, no `cwd`, output masked and kept to 64 KiB) and `integrate` (see step 4b). A step the runner lost is not started again.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `runtime/services/regression-proof.ts`                      | The regression proof job on the enabler's runner (`POST/GET/DELETE /api/threads/:id/regression-proof`): head checkout twice, then base checkout, both temporary and prepared alike; verdict `pass` / `fail` (`failureKind` `test` / `environment`) / `skipped`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## A run

0. **Queue** (sent issues): a send writes one `requested` row per accepted issue, with the chosen
   flow (`flow_name`) and a `queue_order`; issues sent together go oldest first. `requested` holds
   no slot and no flow drives it. A send is refused as a whole when the factory is paused or
   cannot work now (409, with the reason), and per issue when it is closed, a pull request,
   missing, or already in the factory.
1. **Admit**: each tick fills `maxConcurrent − slot-holding runs`: first the `requested` runs in
   queue order (compare-and-set `requested → queued`), then, in automatic mode, labelled issues
   (a new `queued` row, `source = 'label'`). The tick's count is only a first guess: every write
   that puts a run in flight (admit, label admission, Retry, take-over) re-checks the cap in the
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
   back to their loop with the failing checks, the rest are requeued; no red half: one at a time,
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
   `{{stack_branch}}`; its merge group stays the base's). It waits for the blocker at the end of
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
  branch and PR; a completed implement step is kept, later steps run again. Refused (409) while
  the factory already runs `maxConcurrent` runs. A `no_change` run (or one parked with reason `no change`)
  keeps nothing (replaying its thread would only reach `no change` again): a new agent starts.
  The threads the retry does not keep are archived (unless one is still running), so the list does
  not show the old failed thread next to the new one under the same title.
- **Take over**: when the thread's **owner** follows up on a parked run's last thread after it
  parked (noted by `POST /api/threads/:id/message`), the run resumes from that step when the thread
  completes (when the factory is full, the run stays parked; a later completion of the follow-up,
  or a Retry, takes it over once a slot frees). A steer sharee's follow-up never does: it would otherwise move the flow toward a merge
  in the enabler's name. The note is in memory; after a restart use Retry.
- **Lost access**: if the enabler loses `steer`, the factory is turned off and their open runs are
  stopped (`factory.disabled_access_lost` audit).

## The factory view

`/factory` lists every run of the caller's factories, as a list (the default) or a board
(openspec `factory-pipeline-board`; the choice is kept in localStorage, `funny:factory-view-layout`).
The search, project and state filters and the **Active** filter (hides `merged`, `no_change`,
`stopped`) apply to both.

- **Columns** (`components/factory-board/board-columns.ts`) come from the run's `state`, never from
  its thread's stage (which folds every active step into `in_progress`): Queue (`requested`,
  `queued`), Triage, Implementing (`working`, `fixing`), PR · Proof · CI (`pr_open`, `waiting_ci`),
  Review, Merge, Needs a person (`needs_info`, `waiting_human`, `failed`, `no_change`, and any state
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
- **Run detail panel** (openspec `factory-run-detail`, `components/factory-board/run-detail/`): a
  board card, or a list row's details button, opens a side panel named by the `run` search
  parameter (`/factory?run=<id>`, `use-selected-factory-run.ts`), so it can be linked; an id that
  is not listed clears the parameter once the runs have loaded. It is a view of the listed run, so
  it follows it live: header with the run controls and why it stopped, the flow, triage's decision
  (contract, questions or split), the regression proof, one entry per review verdict with its
  findings, risk and CI, and every agent thread (`thread-links.ts`: triage, implementer, one
  reviewer per review). The list row's title still opens the run's thread.
- **Health header** (`FactoryHealthHeader.tsx`, `factory-health.ts`): over every listed run, not
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
