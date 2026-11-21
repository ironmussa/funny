# workflow-engine Specification

## Purpose

Defines how a workflow graph executes: when nodes start, how branches join, how bounded loops
repeat a region, how limits shared across runs are applied, and how a run resumes.

## Requirements

### Requirement: A node starts when its dependencies allow it

The engine SHALL start a node as soon as its join rule is satisfied by the nodes it depends on,
without waiting for unrelated nodes, and SHALL run independent nodes of one run in parallel up
to the run's concurrency limit. A flow in which no node declares dependencies SHALL run its
nodes in declaration order.

#### Scenario: A slow branch does not hold another

- **WHEN** node `c` depends only on `a`, node `d` depends only on `b`, `a` finishes and `b` is
  still running
- **THEN** `c` starts without waiting for `b`

#### Scenario: A flow without dependencies keeps its order

- **WHEN** a flow declares nodes `x`, `y`, `z` and none has `depends_on`
- **THEN** they run one after the other in that order

### Requirement: Nodes read only their own dependencies' outputs

A node SHALL see the run's inputs and the outputs of the nodes it depends on, directly or
transitively, and SHALL write only its own output, so that the order in which parallel
branches finish does not change what any node reads.

#### Scenario: Parallel outputs do not collide

- **WHEN** parallel nodes `review-code` and `review-security` both finish and `merge` depends on
  both
- **THEN** `merge` reads both outputs under their node ids, whichever finished first

### Requirement: Joins follow the node's trigger rule

A node SHALL join its dependencies by its trigger rule: `all_success` by default (no dependency
failed; a skipped dependency counts as done), `all_done` (every dependency finished), or
`one_success` (at least one dependency succeeded). A node whose rule can no longer be satisfied
SHALL be skipped.

#### Scenario: Default join with a failed branch

- **WHEN** a node with the default rule depends on two nodes and one of them failed with
  `on_error: continue`
- **THEN** the node is skipped

#### Scenario: Run when any branch succeeds

- **WHEN** a node with `one_success` depends on two nodes and the first succeeds
- **THEN** the node starts without waiting for the second

### Requirement: Loops repeat a region a bounded number of times

A node with `loop: { back_to, until, max_iterations }` SHALL, after it succeeds and while
`until` is false, run again every node on a path from `back_to` to itself, up to
`max_iterations` visits; then it SHALL fail with "loop exhausted". Nodes outside the region that
depend on it SHALL wait until the loop exits. `until` SHALL be evaluated after the declaring
node, not after the last node of the flow. A flow MAY declare several loops; their regions SHALL
be nested or disjoint, and a flow with overlapping regions SHALL be refused when it loads,
naming both loops.

#### Scenario: Review findings send the run back to the implementer

- **WHEN** `review` declares `loop: { back_to: implement, until: verdict is pass,
  max_iterations: 3 }` and the first review fails
- **THEN** `implement`, the nodes between it and `review`, and `review` run again, and nodes
  after `review` wait

#### Scenario: Nested loops

- **WHEN** `ci` loops back to `implement` and `merge` loops back to `implement` around it
- **THEN** the flow loads, and a conflict at `merge` repeats `implement` through `merge`,
  including `ci`'s own loop

#### Scenario: Overlapping loops are refused

- **WHEN** one loop covers `a` to `c` and another covers `b` to `d`, with `a`, `b`, `c`, `d` in
  a chain
- **THEN** the flow is refused when it loads, naming both loops

#### Scenario: Loop exhausted

- **WHEN** a loop's `until` is still false after `max_iterations` visits
- **THEN** the declaring node fails with "loop exhausted" and its `on_error` applies

### Requirement: A failing branch fails the run unless it continues

A node that fails with `on_error: fail` SHALL fail the run: the engine SHALL cancel the nodes
still running in other branches, wait for them to stop, and report the first failure. A node
with `on_error: continue` SHALL be marked failed and the run SHALL go on according to the joins.

#### Scenario: A failure cancels a sibling branch

- **WHEN** two branches are running and one node fails with `on_error: fail`
- **THEN** the other branch's running node is cancelled and the run ends failed with that
  node's error

### Requirement: Concurrency groups limit a node across runs

A node with `concurrency: { group, limit }` SHALL NOT start while `limit` executions of nodes
in the same group are running across all runs of the host; it SHALL wait, reported as waiting
for a slot, and SHALL start when a slot frees. The group SHALL be computed from the run's inputs
only. The host MAY replace the limit and order the waiters. A slot SHALL be released when the
node ends, fails or is cancelled, and a slot whose holder stops renewing it SHALL expire.

#### Scenario: One merge at a time per repository

- **WHEN** runs #12 and #13 of the same repository reach `merge` with
  `concurrency: { group: merge-{{inputs.repo}}, limit: 1 }`
- **THEN** one of them merges while the other waits for a slot, and it starts when the first
  ends

#### Scenario: Different repositories do not wait for each other

- **WHEN** runs of two different repositories reach that `merge` node
- **THEN** both start

#### Scenario: A crashed holder frees its slot

- **WHEN** the server holding a slot stops without releasing it
- **THEN** the slot expires and a waiting run can start

### Requirement: A batch group runs a node once for several runs

A concurrency group MAY declare `batch: { max, wait }`. When its slot frees, the engine SHALL make
the first waiting run the leader and add up to `max - 1` other waiting runs of the group as
members, waiting up to `wait` for more. The leader's node SHALL run once with the members' inputs
and SHALL settle each member with its own outcome; a member's node SHALL NOT run and SHALL complete
with the outcome the leader settled for it, recorded under the member's own run. The leader MAY
settle a member as requeued; that member SHALL wait again in the place it had. A member whose run
is cancelled SHALL leave the batch. If the leader's run is cancelled or stops without settling,
its unsettled members SHALL return to waiting.

#### Scenario: Three runs merged as one batch

- **WHEN** three runs wait on a `merge` node whose group has `batch: { max: 5, wait: 60s }`
- **THEN** one of them runs the node once for all three, and each run continues with the outcome settled for it

#### Scenario: A member fails inside the batch

- **WHEN** the leader settles one member as failed and the others as succeeded
- **THEN** that member's node fails (its `on_error` and loops apply) and the others' nodes succeed

#### Scenario: A member is requeued

- **WHEN** the leader settles a member as requeued
- **THEN** that member's node has not run or failed, and it is first among the group's waiters again

#### Scenario: The leader's run is cancelled

- **WHEN** the run leading a batch is cancelled before it settled the members
- **THEN** the leader's node ends cancelled and the members wait again without an outcome

#### Scenario: The leader's server stops mid-batch

- **WHEN** the server running the leader stops before it settles the members
- **THEN** after the lease expires the members wait again and a new leader takes them

### Requirement: A resumed run does not repeat recorded work

The engine SHALL record each node execution (node, loop visit, attempt, status, output) through
the host. When a run resumes, a node execution recorded as succeeded SHALL NOT run again: its
recorded output SHALL be used, and conditions SHALL be evaluated on recorded outputs so the run
takes the same path. A node execution recorded as started but not finished SHALL run again with
its recorded data, so that it can adopt the work it had started.

#### Scenario: Resume after a restart with parallel branches

- **WHEN** a run with two parallel agent branches is interrupted after one branch succeeded and
  while the other was running, and the run resumes
- **THEN** the succeeded branch is not executed again, and the running one is resumed with its
  recorded data instead of starting new work

#### Scenario: Resume inside a loop

- **WHEN** a run is interrupted during the second visit of a loop and resumes
- **THEN** the first visit's executions are not repeated and the second visit continues

### Requirement: A flow warns about dependents a continued failure skips

When a node has `on_error: continue` and another node depends on it without declaring a
`trigger_rule`, parsing the flow SHALL report a warning on the dependent that names both nodes
and says that adding `trigger_rule: all_done` makes it run after the failure. A warning SHALL
NOT make the flow invalid: the flow SHALL still load, save and run. Declaring any
`trigger_rule` on the dependent SHALL suppress the warning. Every diagnostic SHALL have a
severity of `error` or `warning`; a diagnostic with no stated severity SHALL be treated as an
error.

#### Scenario: A dependent on the default join is warned

- **WHEN** node `tests` has `on_error: continue` and node `notify` has `depends_on: [tests]`
  and no `trigger_rule`
- **THEN** the flow parses as valid and reports one warning on `notify` that names `tests`
  and suggests `trigger_rule: all_done`

#### Scenario: An explicit trigger rule silences the warning

- **WHEN** the same flow gives `notify` `trigger_rule: all_success` or `trigger_rule: all_done`
- **THEN** the flow parses as valid and reports no warning

#### Scenario: Nodes that continue without dependents are not warned

- **WHEN** a node has `on_error: continue` and no node depends on it
- **THEN** the flow reports no warning

#### Scenario: A warning does not block the editor

- **WHEN** the workflow editor shows a flow whose only diagnostics are warnings
- **THEN** the warnings are visible and saving and running the flow stay enabled

#### Scenario: An error still blocks the editor

- **WHEN** the workflow editor shows a flow with at least one error diagnostic
- **THEN** saving and running the flow are disabled

#### Scenario: Warnings are logged when a flow is loaded

- **WHEN** the runtime or the factory loads a flow that has warnings
- **THEN** each warning is logged with the flow name and the node path, and the flow is used
  as loaded
