# Proposal

## Why

Parallel agent runs make integration the bottleneck. Every merge moves the default branch under
the other runs, so each of them has to bring the base in again, rerun its checks and, on a
conflict, ask an agent to resolve it; the next merge starts the cycle over. Merging one pull
request at a time costs one CI run per pull request at least (10 pull requests with a 5-minute
CI: 50 minutes, plus every conflict round), and textual conflicts that are not real conflicts
(two runs adding imports or functions next to each other, a lockfile, a migration number) go to
an LLM. This repository shows it: about 25 pull requests merged in one day, the last ones one by
one, and two repository-wide lint changes stuck in conflict with everything merged before them.

`factory-agent-roles` serialises merges per repository (one at a time, on the current base) and
can delegate to GitHub's merge queue when a repository requires it. That is correct but slow,
and it ties funny's throughput to a GitHub feature many repositories do not use. The state of
the art (bors, GitHub merge queue, Mergify, Trunk, Uber's SubmitQueue) is that a machine
integrates, not the author: candidates are tested together on the current base, in batches,
with bisection when a batch fails, and the author is asked only for a real conflict.

## What Changes

- **funny's own merge queue.** The `merge` node takes the runs waiting for a repository and base
  branch as one batch (engine batch groups, `workflow-dag-engine`), builds a temporary branch
  `factory/queue/<n>` = base + each pull request in order through the provider's API (no
  checkout), waits for CI on it, and merges the batch in order only if the base has not moved;
  if it moved, it rebuilds the batch on the new base. A red batch is bisected: halves are tested
  in parallel until the run that breaks it is found; that run goes back to `address`, and
  the others are tested together once more before they merge. Speculative testing (base+#1, base+#1+#2, … at once) is out of scope for v1.
- **GitHub's merge queue only when required.** When the base branch's rules require GitHub's
  merge queue, nobody can merge around it; the queue then delegates to it (as in
  `factory-agent-roles`). Otherwise funny's queue is used.
- **A provider interface for integration.** Branch creation, merging a ref into a branch,
  merging a pull request, reading checks, and reading branch rules go through one interface, so
  a GitLab provider can be added later.
- **A deterministic `integrate` step.** Before asking the implementer to resolve a conflict, the
  run's worktree merges the base in with a structural merge driver (weave) and `git rerere`,
  runs the repository's declared regenerators, runs the fast checks, and pushes. Only a conflict
  left after that goes to `address` (the implementer).
- **Commands in factory flows.** `run_command` is allowed in factory flows (today it is refused),
  limited to the run's own worktree or sandbox on the enabler's runner, never on the server, with
  a timeout and its output recorded on the run. The implementer agent can already run any command
  there; this makes deterministic steps possible without an LLM.
- **Declared regenerators.** `.funny/integrate.yaml` on the default branch maps paths to the
  command that regenerates them (`bun.lock` → `bun install`, numbered migrations → a renumber
  script). A conflict on those paths is regenerated, never merged by hand or by an agent.
- **Regenerable changes.** A flow whose change is produced by a command (a codemod, `--fix`) can
  declare that a conflict re-runs the command on the new base instead of resolving it.
- **Early integration.** After each merge into a repository, runs in flight whose changed paths
  overlap the merge are checked for mergeability (a read); one that no longer merges runs
  `integrate` then, while its implementer thread still has the context, not at merge time.
- **Stacked pull requests.** A factory can work an issue whose blocker is in flight on top of the
  blocker's branch (`dependencies: stack`) instead of waiting for the blocker to merge; the merge
  queue keeps the order.
- **Queue order policy.** Within a repository: blockers first, smaller changes before larger
  ones, batches of runs that touch disjoint paths, regenerable changes alone.
- **Integration readiness.** The factory settings show what a repository lacks for the queue
  (CI not running on `factory/queue/**`, no structural merge driver on the runner, CI slower
  than the batch wait) and can open a pull request that adds the CI trigger.
- **Integration metrics.** The per-run counters shipped in #371 (CI rounds, red, conflicts,
  blocked, timeouts, agent fixes) gain integrate rounds, conflicts resolved without an LLM, batch
  sizes and bisection rounds, and the 30-day summary shows them.

## Capabilities

### New Capabilities

<!-- None: these are the issue factory's behaviour. -->

### Modified Capabilities

- `issue-factory`: funny's merge queue (batches, bisection, base check, delegation), the
  `integrate` step and declared regenerators, `run_command` in factory flows, regenerable
  changes, early integration, stacked pull requests, queue order, integration readiness and
  integration metrics.

## Impact

- **Depends on** `workflow-dag-engine` (batch concurrency groups, loops) and
  `factory-agent-roles` (the `merge` node, the `address` loop, risk class and review gate).
- **`packages/workflows`**: `run_command` allowed for factory flows with the factory's limits; a
  `regenerate: <node>` option on `merge`; the built-in flows use `integrate`.
- **`packages/core`**: the integration provider interface and its GitHub implementation (create
  branch, merge ref into branch, merge pull request, checks, branch rules); the `integrate`
  operation on a worktree (merge with weave + rerere, regenerators, checks, push).
- **`packages/server/src/services/factory/`**: the merge queue (batch, temp branch, base check,
  bisection, delegation), early integration on merge events, stacked runs in admission, queue
  order, readiness checks, metrics.
- **`packages/runtime`**: runs `integrate` and `run_command` in the run's worktree or sandbox,
  with timeout and recorded output; configures weave and rerere in factory worktrees and
  sandboxes.
- **Database**: queue batch rows (members, base SHA, temp branch, state) and bisection attempts;
  `factory_runs.metrics` gains the new counters (JSON, no migration); `factory_settings.dependencies`.
- **Client**: integration readiness panel; batch and queue position on the run row; the new
  metrics in the 30-day summary.
- **Docs**: `openwiki/architecture/issue-factory.md`, `docs/architecture/state-machines.md`
  (queue batch machine).
