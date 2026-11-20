# Proposal

## Why

Workflow YAML already declares a graph (`depends_on`), but the engine cannot run the graphs
the issue factory now needs. `@funny/pipelines` runs a DAG level by level (every node of a
level waits for the slowest node of the previous one) and falls back to a straight sequence as
soon as a flow has a loop; the compiler allows a single loop per flow. The factory's agent
roles (`factory-agent-roles`) need several correction loops that go back to the implementer
(CI, review findings, integration conflicts), parallel branches (two reviewers on one change),
and limits that span runs ("one merge at a time per repository", "three implementers per
factory"). The factory also resumes a run by replaying agent steps in call order, which breaks
as soon as two branches run at once.

## What Changes

- **A real DAG executor.** A node starts as soon as the nodes it depends on have finished, not
  when a whole level has; independent branches run in parallel within a run, bounded by the
  run's concurrency.
- **Join rules.** A node can say how it joins its dependencies: `all_success` (default),
  `all_done` or `one_success`.
- **Multiple bounded loops.** Any node can declare `loop: { back_to, until, max_iterations }`.
  When the node finishes and `until` is false, the loop's region (the nodes from `back_to` to
  that node) runs again. Loop regions must be nested or disjoint; a flow whose regions overlap
  is refused when it loads. The single-loop limit is removed.
- **Batch groups.** A concurrency group can batch: the first waiter leads, takes up to `max` waiting runs, runs the node once and settles each member with its own outcome (used by the factory merge queue, `factory-integration`).
- **Concurrency groups across runs.** A node can declare
  `concurrency: { group, limit }`, where `group` is a template (for example
  `merge-{{inputs.repo}}`). A run waits before entering the node until the group has room. The
  engine asks the host for a slot; the host decides how slots are shared (in memory, or leases
  in the database across server instances).
- **An execution journal.** The engine records every node execution (node id, loop visit,
  attempt, status, output) through the host. A resumed run replays the journal: recorded
  executions return their recorded output instead of running again. This replaces the
  factory's "agent steps numbered in call order".
- **Graph view.** The workflow graph (`graph.ts`) shows loop edges per region, join rules and
  concurrency groups, so the flow editor and run views can draw them.
- **BREAKING (engine semantics, internal):** a loop's `until` is evaluated after the node that
  declares it, not after the last node of the flow. Built-in flows are unaffected (their only
  loop is on the last node); repository flows with a loop on a middle node change behaviour.
  The level-by-level DAG mode and the sequential fallback are removed.

## Capabilities

### New Capabilities

- `workflow-engine`: how a workflow graph executes: scheduling of nodes, joins, loops,
  concurrency groups across runs, and the execution journal used to resume.

### Modified Capabilities

<!-- None: the issue factory's spec is changed by factory-agent-roles, which uses this. -->

## Impact

- **`packages/pipelines`**: new executor (ready-queue scheduler, joins, nested loops,
  concurrency-group port, journal port); the sequential and level modes go away behind the same
  `runPipeline` entry point.
- **`packages/workflows`**: schema (`trigger_rule`, `concurrency`, several `loop`s), validation
  of loop regions and groups, compiler mapping, `graph.ts`.
- **Hosts**: `server/services/factory` (journal and concurrency groups on the database, resume
  by journal instead of `threadIds` order), `runtime/services/pipeline-manager.ts` and
  `git-workflow-service.ts` (in-memory journal and groups), `orchestrator`, `harness`,
  `scheduler` (in-memory defaults; no behaviour change for their flows).
- **Database**: a node-execution journal table and a concurrency lease table (server).
- **Client**: the flow graph view draws loop regions, joins and groups.
- **Docs**: `openwiki` pipelines / automation page, `docs/architecture/state-machines.md`
  (node execution and lease machines).
