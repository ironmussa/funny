# Design

## Context

See proposal.md (Why). Current state:

- `@funny/pipelines` `runPipeline` has two modes. **Sequential** (no node has `dependsOn`):
  nodes in order, one optional loop checked after the last node. **DAG** (some node has
  `dependsOn` and there is no loop): `computeLevels` groups nodes by depth and runs each level
  with `Effect.forEach` (bounded by `maxConcurrency`, default 8); a level waits for its slowest
  node. A flow with a loop always runs sequentially.
- `@funny/workflows` compiles YAML to a `PipelineDefinition`: it passes `depends_on`, refuses
  more than one `loop`, and folds parallel results by `outputs[id]` (`mergeContexts`).
- Node retry (`retry.before_retry`) and `when` guards already exist and stay.
- The server factory resumes a run by numbering agent steps in call order and replaying
  `factory_runs.thread_ids[step]` (`factory-action-provider.ts`). Parallel branches make that
  order nondeterministic.
- Consumers: server factory, runtime pipeline manager and git workflow service, orchestrator,
  harness, scheduler.

## Goals / Non-Goals

**Goals:**
- One executor for every graph shape, with the same entry point (`runPipeline`).
- Loops, joins and cross-run limits are declared in the flow and enforced by the engine or by
  a host port, never by convention in prompts.
- A run resumes after a restart without running a recorded node again, whatever ran in
  parallel.

**Non-Goals:**
- Dynamic fan-out inside a run (map over a list). Fan-out across issues is the factory's runs.
- Arbitrary back edges outside loops (`goto`).
- Cross-host concurrency groups for the runtime, orchestrator or harness (in-memory there).

## Decisions

### D1. A ready-queue scheduler replaces the two modes

The executor keeps a state per node (`pending`, `waiting_slot`, `running`, `succeeded`,
`failed`, `skipped`) and starts every node whose join rule is satisfied, bounded by the run's
`maxConcurrency`, as an Effect fiber with its own `AbortSignal`. A node without `depends_on`
in a flow where no node has it depends on the previous node (so today's sequential flows keep
their order). Each node writes only `outputs[<id>]`; the context a node sees is the base
inputs plus the outputs of its transitive dependencies, so finish order cannot change what a
node reads. `mergeContexts` stays for hosts with a custom context shape.

*Alternative:* keep levels and add loops. Rejected: a slow branch would hold unrelated
branches, and loops over levels have no clear region.

### D2. Join rules

`trigger_rule` per node: `all_success` (default: no dependency failed; skipped counts as
done), `all_done` (every dependency finished, whatever the result), `one_success` (at least
one succeeded; the node starts when the first one does and the rest are not cancelled). A node
whose join can no longer be satisfied is `skipped`, and so are its dependents under
`all_success`. `when` false → `skipped` (unchanged).

### D3. Loops are regions

`loop: { back_to, until, max_iterations }` on node X defines the region: every node on a path
from `back_to` to X, both included. When X succeeds and `until` (JSONata over the context) is
false, the executor resets the region's nodes to `pending`, increments the region's visit
number, and schedules again from `back_to`. Nodes outside the region that depend on a node
inside it wait until the loop exits. Validation at load: `back_to` is X or an ancestor of X;
any two regions are nested or disjoint; a region contains no node with `concurrency` whose
group another region of the same flow also uses (to keep slot release well defined). Exceeding
`max_iterations` fails X with "loop exhausted", and X's `on_error` applies. Templates get
`{{LOOP_ITERATION}}` of the innermost region. `retry` stays per node, inside one visit.

The BREAKING change: `until` is checked after X, not after the last node. For the only built-in
loop (`code-review`, on its last node) the behaviour is identical.

### D4. Failure inside parallel branches

A node that fails with `on_error: fail` fails the run: the executor interrupts running fibers
(their signals abort), waits for them to settle, and reports the first failure.
`on_error: continue` marks the node failed and lets joins decide. Cancellation of the run
interrupts every fiber and releases every slot (D5).

### D5. Concurrency groups through a host port

`concurrency: { group, limit }` on a node. `group` is a template evaluated against the run's
**inputs only** (never node outputs, so a resumed run asks for the same group). Before running
the node the executor calls the host's
`ConcurrencyGate.acquire({ group, limit, holder, signal }) → release`, where `holder` is
`<runId>/<nodeId>/<visit>`; the node is `waiting_slot` meanwhile, reported through
`onStateChange`. The host may replace the limit (`resolveLimit(group, declared)`) and order
waiters (`priority(holder)`), so the factory can lock "merge, one per repository" and order
merges by admission and blockers.

Hosts: an in-memory gate (default, FIFO) for runtime, orchestrator, harness and scheduler. The
server implements leases: a row per holder in `workflow_concurrency_leases` (`group`,
`holder`, `expires_at`), granted in a transaction when fewer than `limit` live leases exist for
the group and the requester is first among waiters (`workflow_concurrency_waiters`,
`requested_at`). A held lease is renewed every 30 s and expires after 2 min without renewal, so
a crashed server frees its slots; a resumed run asks again for the slot of a node it was running.

*Alternative:* limits in each host's own code (today's `maxConcurrent`). Rejected: every new
limit would be a new mechanism, and flows could not declare them.

### D5b. Batch groups: one execution for several runs

A concurrency group can batch: `concurrency: { group, limit: 1, batch: { max, wait } }`. When the
slot frees, the first waiter becomes the **leader**; the gate also hands it up to `max - 1` other
waiters of the group (waiting up to `wait` for more to arrive, never past the first waiter's own
deadline), who become **members**. The leader's node runs once, receives
`batch.members` (each member's holder and run inputs), and settles every member with its own
outcome (`succeeded` with an output, `failed` with an error, or `requeued`: the member goes back
to the waiters in the place it had, for work the leader could not finish for it) through the gate
before it ends.
A member's node does not execute: it stays `waiting_slot` until its outcome is settled, then
completes with that outcome, journaled under its own run (D6), so its loops and joins work as if
it had run. A member whose run is cancelled leaves the batch; the leader sees it as settled
`cancelled`. When the leader's own run is cancelled, its node requeues the unsettled members
before it ends; if the leader's run dies, its lease expires (D5) and the unsettled members return
to the waiters. The server stores batch membership with the leases; the in-memory gate supports it
too.

This is how the factory's merge queue tests and merges several pull requests at once
(`factory-integration`).

*Alternative:* a separate "collector" node type. Rejected: batching is a property of how a node
is shared across runs, which concurrency groups already model.

### D6. The journal and resume

The executor reports every node execution to the host's `Journal` port:
`{ runId, nodeId, visit, attempt, status, output?, error?, startedAt, finishedAt? }`, keyed by
`(nodeId, visit, attempt)`. On start, the executor loads the journal: a `(nodeId, visit)` with
a `succeeded` entry is not executed again, its recorded output is used, and `when` / `until`
are evaluated on recorded outputs, so the run follows the same path. A `running` entry without
an end is executed with `resume: { recorded }` in its call, so the action can adopt the work
it started (the factory adopts the thread recorded in the entry's output metadata instead of
matching titles). The server stores the journal in `workflow_node_executions`; other hosts
keep it in memory (no resume, as today).

This replaces `factory_runs.thread_ids` as the resume source; the column stays as a display
list derived from the journal.

### D7. Validation that belongs to the host

The engine validates graph shape (D3). A host can add rules through `validate(parsed)`. The
factory adds one: two agent steps that continue the same thread cannot be in parallel branches
(a thread runs one agent turn at a time).

### D8. Graph view

`graph.ts` emits loop edges per region (`kind: 'loop'`, label with `max_iterations`), the join
rule on the target node, and the concurrency group on the node; run views color nodes by
journal state, including `waiting_slot`.

## Risks / Trade-offs

- [Rewriting the executor can change timing of existing flows] → Sequential flows map to a
  chain (D1); the existing engine test suite runs unchanged against the new executor before
  the old modes are deleted.
- [Lease expiry while a long node is running on a slow server] → Renewal every 30 s with a
  2 min expiry; a node whose lease expired is not stopped, but its release is a no-op and the
  next holder may start (documented); the factory's merge node re-verifies its preconditions
  on entry, so a double holder cannot merge stale state.
- [Journal grows with loops and retries] → One row per execution; rows are deleted with the run
  (factory runs are pruned like today).
- [Overlapping loop regions are refused, which forbids some graphs] → Structured loops are what
  makes resume and slot release well defined; overlapping cases can be rewritten as nested.

## Migration Plan

1. Land the executor behind `runPipeline` with in-memory gate and journal; run the existing
   pipelines and workflows suites unchanged.
2. Schema and compiler: `trigger_rule`, `concurrency`, several loops; remove the single-loop
   refusal.
3. Server: journal and lease tables, factory resume through the journal (migrate in-flight
   runs: a run without journal rows resumes through `thread_ids` once, then writes journal rows).
4. Graph view.
Rollback: the old executor stays in the repository until step 3 has shipped.
