# Design

## Context

See proposal.md (Why). The state this design starts from:

- `factory-agent-roles` (planned): the built-in flow is `triage → implement → pull-request →
  address → ci → review → merge`; `merge` holds the concurrency group
  `merge:{{inputs.repo}}:{{inputs.base_branch}}` (limit 1, pinned by the factory), re-verifies
  the review and risk on entry, and either enqueues in GitHub's merge queue (when the branch
  requires it) or does update-branch + checks + merge, one pull request at a time. A conflict or
  red checks end `merge` with feedback; the merge loop goes back to `address`, the implementer.
- `workflow-dag-engine` (planned): loops, joins, concurrency groups through a host
  `ConcurrencyGate`, an execution journal; this change relies on its batch groups (its D5b).
- Today the factory refuses `run_command` (`factory-action-provider.ts`: "the server has no
  checkout"); `wait_ci` / `merge` run on the server with the App token capped by the enabler;
  agent steps run in the run's worktree or sandbox on the enabler's runner.
- GitHub's `update-branch` merges server-side with no merge drivers, so it reports conflicts a
  structural driver would resolve. funny already configures weave for local projects
  (`ensureWeaveConfigured` in `@funny/core/git`), not for factory worktrees or sandboxes.
- Per-run integration counters (`factory_runs.metrics`, JSON) and the 30-day summary exist
  (#371).

## Goals / Non-Goals

**Goals:**
- A batch of ready pull requests reaches the default branch in about one CI run when it is green,
  and the default branch only ever receives commits that were tested on the base they land on.
- An LLM is asked to resolve a conflict only when a deterministic step (structural merge,
  rerere, a declared regenerator, re-running a declared command) could not.
- No dependency on GitHub's merge queue feature; delegation only where a repository forces it.

**Non-Goals:**
- Speculative testing of several queue prefixes at once (v2, after the metrics show batch
  failure rates and CI cost).
- Queues partitioned by affected targets (two independent queues per repository).
- A GitLab provider (the interface is designed for it; the implementation is later).
- Partitioning the queue per user: the merge group is shared by every factory on a repository
  (`factory-agent-roles` D8), so one batch may hold runs of different enablers; no identity
  crosses because every write about a member uses that member's own enabler-capped token (D3).
- Automatic merge of revert pull requests (unchanged from `factory-agent-roles`).

## Decisions

### D1. funny's own queue by default, GitHub's only when required

When the base branch's rules (rulesets / protection) require GitHub's merge queue, any merge has
to go through it, including the App's; the `merge` node then delegates to it as
`factory-agent-roles` D8 describes. In every other repository the `merge` node runs funny's queue
(D2). The choice is read from the rules each time a batch starts, so enabling the requirement
later switches the repository over.

*Alternative:* always use GitHub's merge queue and only help repositories enable it. Rejected:
it needs an organization repository and a plan that has it, the repository's CI must listen to
`merge_group`, and it gives funny no say in batch composition or order.

### D2. Batches and bisection

The `merge` node's group is a batch group (`workflow-dag-engine` D5b): `batch: { max, wait }`,
default `max: 5`, `wait: 60 s`, configurable per factory. The leader of a batch:

1. Re-verifies every member (review pass for its head SHA, risk class, branch history contains
   the reviewed commit — `factory-agent-roles` D8); members that fail go back with that reason.
   It records each member's head SHA: that commit is what the batch tests and the only one it
   will merge.
2. Reads the base SHA `B` and builds the batch commit from `B`, merging each member's head in
   queue order through the provider (`mergeRefInto`, server-side, no checkout). Every merge
   through GitHub's merges API is a push, so the merges happen on a staging ref
   (`factory/staging/<batchId>`, a pattern CI does not listen to); only the finished commit is
   pointed to by `factory/queue/<batchId>`, so CI runs once per batch and not once per member.
   Many repositories run their workflows on every push, whatever the branch, so each staging
   merge commit carries `[skip ci]` in its message, and the queue branch points at a new commit
   with the same tree and no marker (created through the git data API).
   A member that does not merge cleanly onto the batch so far is taken out and sent to
   `integrate` (D5); the batch continues without it. The batch branches are written with the
   App token capped by the leader's enabler (contents write, which every member's enabler has,
   since each of them pushed its pull request); no member's pull request is written with it.
3. Waits for CI on the batch commit. The verdict is stricter than `wait_ci`'s: the checks that
   must report green are the base branch's required checks, or, when it requires none, every
   check that reported on the members' pull request heads. A batch commit with no checks is
   never green (`wait_ci` accepts `no-checks` after a grace period; here that would merge an
   untested batch). Expected checks that never start end the batch as "CI did not run on the
   queue branch": no member is blamed, the members wait again and the readiness check (D12)
   blocks further batches with that reason.
4. Green: if the base is still at `B` and every member's pull request head is still the
   recorded SHA, merges the members' pull requests in order (D3); if the base moved, or a member
   left or changed (below), rebuilds the batch (step 2).
5. Red: first tests the same tree once more, by pointing the queue branch at a new commit with
   that tree (it works with any CI system and needs no permission to re-run jobs; a red that
   turns green is recorded as a flake and the batch goes on to step 4). Still red: bisects. The members are split in two halves, each
   tested as its own branch from `B`, in parallel, and every red half is split again, so two
   culprits are both found. Isolated culprits get the failure as feedback and go back to
   `address`. The members that were not isolated are **not** merged on the strength of their
   halves (the halves were tested apart, never together): the leader settles them as requeued
   (`workflow-dag-engine` D5b), so they form a new batch at the head of the queue, built and
   tested once more (step 2). If no half is red (the failure needs members
   that were in different halves), the batch is split into batches of one, in queue order. A red
   batch of one is that member's failure directly.

A batch row records members, base SHA, branch, attempt and state; bisection attempts are rows
under it, so a restart resumes the batch from its journal (`workflow-dag-engine` D6). Temporary
branches are deleted when their batch ends.

A member leaves a batch when its run is stopped or taken over, or when its pull request's head
is no longer the recorded SHA (someone pushed). The batch commit contains that member's change,
so its result no longer describes what would land: the leader merges nothing more from it and
rebuilds without the member. The same holds for the leader's own run: when it is stopped, its
node settles its own member as cancelled, requeues the others and ends; the next leader builds a
new batch. The batch belongs to its row, not to the run that happens to lead it.

*Alternative:* serial update-branch per pull request (today's plan). Kept as the behaviour of a
batch of one; batching is what removes one CI run per pull request.

### D3. What lands is what was tested

After a green batch on base `B`, each member's pull request is merged in queue order with its
own run's enabler-capped token and the pull request's merge method (squash by default). Before
the first merge the base must still be `B` (checked, not assumed); after the last one the server
compares the resulting base tree with the tested batch branch's tree. A mismatch (only possible
if someone pushed in between) opens the post-merge incident flow of `factory-agent-roles`
instead of trusting the result.

Each merge call carries the member's recorded head SHA, so GitHub refuses it if the head moved
between the check and the call. A member whose merge is refused after earlier members landed (a
rule, a moved head, an API failure) stops the landing: the base now holds a prefix of the batch
that was not tested on its own. The server records it (`partial_landing`), requeues the
remaining members at the head of the queue, and the next batch tests them on the new base; the
sentinel of `factory-agent-roles` watches the base in the meantime. A partial landing is not
rolled back.

Reading the rules: rulesets through the branch rules endpoint and the merge queue through the
repository's GraphQL field, both readable with the App's current permissions. Classic branch
protection details need the administration permission, which the App does not ask for; when the
up-to-date rule cannot be read, the queue learns it from GitHub's refusal of the second merge
(handled as a partial landing) and uses batches of one on that branch from then on.

When the base branch requires pull requests to be up to date before merging ("Require branches
to be up to date", `strict` status checks), merging the second member is refused as soon as the
first one lands. On such a branch the queue runs batches of one (update-branch, checks, merge,
as `factory-agent-roles` D8) and the readiness check (D12) says so and recommends either turning
the rule off (the queue already guarantees that what lands was tested on its base) or requiring
GitHub's merge queue, which then takes over by D1. The queue never bypasses a rule.

*Alternative:* fast-forward the default branch to the tested batch commit. Rejected for v1: it
needs push rights around the pull request rules and would drop the squash history the repository
uses.

### D4. A provider interface for integration

`IntegrationProvider` in `@funny/core` exposes `branchRules(repo, branch)`,
`createBranch(repo, name, sha)`, `mergeRefInto(repo, branch, ref)`, `mergePullRequest(...)`,
`checks(repo, sha)`, `deleteBranch(...)`, `enqueueInHostQueue(...)` and `pullRequestMergeability`.
The GitHub implementation uses the App token as today. The queue and early integration only use
the interface.

### D5. The `integrate` step: deterministic first

`integrate` is a factory action executed by the runner in the run's worktree or sandbox (like
an agent step, never on the server):

1. `git merge origin/<base>` (a merge, never a rebase: no force push, the reviewed commit stays in
   history, and the implementer's thread keeps the history it knows), with weave as the merge
   driver for the languages it supports and `rerere` enabled.
2. For each conflicted path matched by a regenerator (D7), take either side, run the
   regenerator, and stage its output.
3. If no conflict remains: run the fast checks declared for integration (default: none), commit
   the merge, push. The run continues to `ci` with the new head.
4. If conflicts remain: abort the merge and end with feedback naming the conflicted paths and
   the diff of the pull request that merged in between; the merge loop goes to `address`.

Review freshness after `integrate`: a merge that brought in only base changes with no conflict
keeps the review (`factory-agent-roles` D8). A merge in which `integrate` resolved conflicts (a
merge driver, rerere or a regenerator) changed code nobody reviewed, so the run passes the review
gate again with the reviewer limited to the resolved hunks and the regenerated paths, not the
whole pull request; a resolved hunk on a sensitive path keeps the run's risk class rules.

`integrate` is a node of the built-in flow and the start of both loop regions, which
`factory-agent-roles` starts at `address`:

```
triage → implement → pull-request → integrate → address → ci → review → merge
                                        ▲                        │        │
                                        └──────── loop ──────────┘        │
                                        └──────── loop ───────────────────┘
```

`integrate` is skipped when the branch already contains the current base; `address` is skipped
when no gate left feedback for the implementer. So a member taken out of a batch for a conflict
(D2 step 2) loops back, `integrate` resolves it, `address` is skipped and the run goes to `ci`
without an agent turn. Early integration (D8) runs the same operation outside the flow.

Loop budget: a round that never reached the implementer is not a correction round. The built-in
merge loop's `max_iterations` becomes a safety bound (10), and the factory counts the rounds
that did reach the implementer (`conflictsSentToAgent` plus red-on-base fixes) and parks the run
in `waiting_human` after 2. Requeues inside the queue (bisection survivors, a rebuilt batch) are
not loop visits at all.

Git configuration: `ensureWeaveConfigured` cannot be reused as it is. It writes
`.git/info/attributes` under the project path, and in a worktree `.git` is a file; and both that
file and `git config --local` belong to the repository's common git dir, so configuring a factory
worktree would change the user's own checkout. A factory run instead carries the configuration
in its process environment (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`:
`merge.weave.driver`, `core.attributesFile` pointing at a file funny owns, `rerere.enabled`), for
`integrate` and for the run's agent steps, so the implementer's own conflict resolutions are
recorded too. Nothing is written to the repository's config. `rerere`'s cache still lives in the
common git dir: worktree runs of one repository on a runner share it with each other and with the
user's checkout; sandboxes do not share it.

*Alternative:* GitHub's update-branch. Rejected as the first step: it has no merge drivers, so it
turns resolvable conflicts into agent work.

### D6. `run_command` in factory flows

The factory accepts `run_command` steps (option (a) of the discussion: any command written in the
flow, not a fixed list). Limits, enforced by the factory, not the flow:
- the command runs only in the run's own worktree or sandbox, on the enabler's runner, with the
  environment the run's agent has — never on the server;
- the flow is read only from the default branch (unchanged rule), so commands passed review;
- a timeout (default 10 minutes, per step `timeout`), after which the process is killed;
- stdout / stderr are recorded on the run (bounded: the last 64 KiB of each), and the exit code
  decides success; before recording, the runner masks the values of the secrets it put in the
  step's environment (the App installation token, provider keys), since a command can print its
  environment.

The implementer agent can already run any command in that worktree; this makes deterministic
steps possible without an LLM and adds no reach the run did not have.

*Alternative:* only a fixed list (integration merge and declared regenerators). Rejected: it would
need a new list entry for every codemod, while the trust boundary is the same.

### D7. Declared regenerators

`.funny/integrate.yaml` on the default branch: `regenerate: [{ paths: [globs], run: command,
timeout? }]`. Read with the flow, validated when the flow loads (Validate flow shows problems),
and executed by `integrate` (D5) under D6's limits. Paths not declared are never regenerated.

### D8. Early integration

When a pull request merges into a repository (by the queue or by a person), the server looks at
the factory runs in flight on that repository whose changed paths (the pull request's file list,
or the contract's likely paths before there is one) overlap the merged change, and asks the
provider whether each pull request still merges (a read; no push, no CI). For one that no longer
merges, the server runs `integrate` on it then (rate-limited per run), so its implementer thread
gets any remaining conflict while it still has the context, instead of at merge time.

Early integration runs outside the flow: the engine has no way to restart a running node from
outside, and it does not need one. `integrate` and an agent never touch the same worktree at
once, so the server takes a per-run workspace lock that agent steps also hold:
- an agent step is active (implementing, addressing, or a `run_command`): the run gets
  `integration_pending_at` (a column, not a run state) and the server integrates when the step
  releases the lock, before the next node starts;
- the run is inside `ci`: the server integrates at once; `wait_ci` reads the pull request's head
  on every look, so it follows the new head by itself;
- the run is inside `review`: the server integrates at once; the review in progress ends with a
  verdict for the old SHA, and the freshness rule (D5) decides whether it still holds: a clean
  merge of the base keeps it, a resolved conflict makes `merge` send the run round the loop for
  the limited review;
- the run waits for or holds the merge slot: left to the queue.

### D9. Regenerable changes

A flow can mark its `merge` node with `regenerate: <node>`: a conflict at integration time, for
that run, re-runs `<node>` (a `run_command` or a step that produces the change from a script, e.g.
`oxlint --fix`) on the new base through a merge loop back to that node, instead of `integrate`
and `address`. The queue order (D11) puts such runs in a batch of their own.

### D10. Stacked pull requests

`factory_settings.dependencies`: `wait` (today: an issue waits until its blockers are finished)
or `stack`. With `stack`, an issue whose blocker has a run in flight with a branch starts its
implementer on top of the blocker's branch and opens its pull request against that branch. The
queue merges the blocker first (D11); when the blocker's branch is merged and deleted, GitHub
retargets the stacked pull request to the default branch, and the next integration brings the
base in. If the blocker's run fails or is stopped, or its pull request is closed without
merging, the stacked run parks in `waiting_human`.

Stacking with squash merges needs three rules, or every stacked run conflicts with its own
blocker (the base gets one squashed commit, the stacked branch holds the blocker's original
commits):
- each push to the blocker's branch triggers early integration (D8) of the runs stacked on it,
  merging the blocker's branch in; a stacked run enters the queue only when it contains the
  blocker's merged head, so both sides of the later merge with the base carry the same change;
- a stacked run is never in the same batch as its blocker: it queues after the blocker landed,
  the server retargeted its pull request to the base branch (an API call; it does not rely on
  GitHub doing it when the branch is deleted) and `integrate` brought the base in;
- until then its review and risk class are computed on the diff against the blocker's branch,
  and they are computed again after the retarget when that diff changed.

### D11. Queue order

The batch leader takes waiters in this order: a blocker before the runs stacked on it or blocked
by it; then admission order, with smaller changes (changed lines) first when the difference is
large (more than 4x), so a small fix does not wait behind a large refactor. A batch prefers
members with disjoint changed paths; regenerable runs (D9) form batches of one.

### D12. Integration readiness

The factory settings show a readiness check per repository, read from the provider and the
runner: CI runs on `factory/queue/**` (or the queue cannot work — the factory refuses to start
batches and says why), a structural merge driver is available on the enabler's runner, the
median CI time against the batch wait, whether the base branch requires GitHub's merge queue
(D1), and whether it requires branches to be up to date (D3: batches of one until the rule
changes). For the CI trigger the panel offers to open a pull request that adds the branch pattern to
the repository's workflow, as a normal factory run; it never edits branch rules.

### D13. Integration metrics

`factory_runs.metrics` (JSON, #371) gains `integrateRounds`, `conflictsResolvedWithoutLlm`,
`conflictsSentToAgent`, `queueWaitMs`, `batchSize` (of the batch that merged it),
`bisectionRounds` and `ciFlakes` (red batches that turned green on the re-run); missing counters read as 0, so no migration. The 30-day summary adds
conflicts resolved without an LLM, median queue wait, average batch size and the share of
batches that needed bisection. `factory.integration_event` gets the matching events.

## Risks / Trade-offs

- [A large batch that fails costs several CI runs to bisect] → `max` 5 by default, bisection in
  parallel halves, and the metrics show the failure rate so `max` can be tuned per factory.
- [Repository CI does not run on `factory/queue/**`] → readiness check (D12) blocks the queue with
  a clear reason and offers the pull request that fixes it.
- [`run_command` lets a flow run arbitrary commands] → only commands from the reviewed default
  branch, only in the run's own worktree/sandbox with the agent's reach, with a timeout and a
  record; never on the server.
- [weave misresolves a conflict silently] → the merged result still goes through the checks, the
  batch CI and the review gate's freshness rules; `conflictsResolvedWithoutLlm` makes the volume
  visible.
- [Stacked runs inherit their blocker's problems] → they park when the blocker fails; `stack` is
  opt-in per factory.
- [Someone merges by hand during a batch] → the base check (D2 step 4, D3) rebuilds or escalates.
- [Flaky CI makes batches bisect for nothing] → one re-run of the failed jobs before bisecting
  (D2 step 5); flakes are counted so a flaky repository shows up in the metrics.
- [A repository requires branches to be up to date] → batches of one on that branch (D3), named
  by the readiness check with the two ways out.
- [Bisection costs one more CI run for the survivors] → accepted: merging halves that were never
  tested together would break D3's guarantee.
- [CI does not start on the queue branch and the batch looks green] → a batch commit without the
  expected checks is never green (D2 step 3).
- [A member's merge is refused after others landed] → partial landing (D3): recorded, the rest
  requeued and retested, the sentinel watching; the base may hold an untested prefix meanwhile.
- [A person pushes to a member's pull request while its batch is tested] → the head SHA is
  recorded and sent with the merge call; the member leaves and the batch is rebuilt (D2).
- [`rerere` replays a resolution recorded in the user's own checkout] → a replayed resolution
  counts as a resolved conflict and is reviewed again (D5).

## Migration Plan

1. Engine batch groups (`workflow-dag-engine`), then the integration provider and `integrate`.
2. `run_command` and regenerators behind the flow loader's validation.
3. The queue with batch size 1 (equivalent to today's plan), then batches and bisection.
4. Early integration, stacked pull requests and queue order; readiness panel; metrics.
Rollback: `batch.max: 1` reproduces the serial lane; `dependencies: wait` keeps today's admission.

## Open Questions

- Whether `rerere` earns its place in v1. Runs merge the base in and never rebase, so the same
  conflict rarely comes back; it mostly helps when an aborted `integrate` is redone by the
  implementer and conflicts again later. The metrics can count replayed resolutions before it
  is decided.
- `[skip ci]` on staging commits and the tree-identical commit for a second test are GitHub
  Actions behaviour; task 7.2 confirms both on the test repository, and other CI systems may
  need their own marker.
