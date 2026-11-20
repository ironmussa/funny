# Tasks

## 1. Executor in `@funny/pipelines`

- [x] 1.1 Implement the ready-queue scheduler behind `runPipeline` (node states, Effect fibers with per-node `AbortSignal`, run `maxConcurrency`, implicit chain when no node has `dependsOn`, context built from transitive dependencies); verify by running the existing `pipelines` test suite unchanged plus new tests for "a slow branch does not hold another" and declaration-order flows
- [x] 1.2 Add join rules (`all_success`, `all_done`, `one_success`) and skip propagation; verify with one test per spec scenario
- [x] 1.3 Add loop regions (region computation, reset and visit counter, outside nodes wait, `until` after the declaring node, "loop exhausted", `LOOP_ITERATION`); verify with tests for a single loop, nested loops, exhaustion, and the `code-review` built-in behaving as before
- [x] 1.4 Failure handling across branches (`on_error: fail` cancels running siblings and waits for them; `continue` lets joins decide; run cancellation interrupts every fiber); verify with cancellation tests that assert signals aborted and no fiber left running
- [x] 1.5 Add the `ConcurrencyGate` port with an in-memory FIFO default, `resolveLimit` and `priority` hooks, `waiting_slot` state reported through `onStateChange`, and release on end / failure / cancel; verify with tests for limit 1 across two runs, different groups, cancellation while waiting, and release on failure
- [x] 1.6 Add the `Journal` port with an in-memory default; skip recorded successes, evaluate conditions on recorded outputs, re-run an unfinished execution with `resume.recorded`; verify with resume tests for parallel branches and a loop's second visit
- [x] 1.7 Add batch groups to the `ConcurrencyGate` (leader + up to `max - 1` members within `wait`, member outcomes settled by the leader and journaled under each member run, `requeued` members back in their place, cancelled members leave, unsettled members return on leader cancellation or loss) with the in-memory gate; verify with tests for a batch of three, a failed member, a requeued member, a cancelled member, a cancelled leader and leader loss
- [x] 1.8 Delete the level-by-level DAG mode and the sequential mode once 1.1–1.6 pass; update the package docs in `packages/pipelines` source comments (both modes went in 1.1; 1.8 removed `computeLevels` and documented the package)

## 2. Workflow schema, validation and compiler

- [x] 2.1 Schema: `trigger_rule`, `concurrency: { group, limit }`, `loop` allowed on several nodes; verify with schema tests for valid and invalid values
- [x] 2.2 Validation: `back_to` is the node or an ancestor; loop regions nested or disjoint (error names both loops); a concurrency group template refers only to `inputs`; host `validate(parsed)` hook; verify with tests for each refusal
- [x] 2.3 Compiler: map the new fields, remove the single-loop refusal, pass `resume` to actions; verify with compiler tests and the existing `issue-to-merge` / `code-review` tests
- [x] 2.4 `graph.ts`: loop edges per region, join rule and group on nodes; verify with graph tests and the flow editor story

## 3. Server host

- [x] 3.1 Migration: `workflow_node_executions` and `workflow_concurrency_leases` / `workflow_concurrency_waiters` in `server/src/db/migrate.ts` and both schemas; verify with the migrate test and `bun run db:push` on a scratch DB
- [x] 3.2 Database journal (record, load per run, delete with the run); verify with repository tests
- [ ] 3.3 Lease gate (transactional grant to the first waiter under the limit, 30 s renewal, 2 min expiry, release); add the lease and execution machines to `docs/architecture/state-machines.md`; verify with tests for two server instances competing, expiry after a missed renewal, and ordering by `priority`
- [ ] 3.4 Batch membership in the server lease gate (members recorded with the leader lease, returned to waiters when it expires); verify with two-instance tests for leader loss and settle-once
- [ ] 3.5 Factory resume through the journal: thread ids live in execution output metadata, adoption uses `resume.recorded`, `thread_ids` becomes a derived display list; a run without journal rows resumes once through `thread_ids`; verify with factory resume tests for both paths
- [ ] 3.6 Factory host validation: two steps continuing the same thread cannot be in parallel branches; verify with a `factory-flow` load test

## 4. Other hosts

- [ ] 4.1 Runtime pipeline manager, git workflow service, orchestrator, harness and scheduler use the in-memory gate and journal; verify their existing test suites pass unchanged

## 5. Client and docs

- [ ] 5.1 Run and flow views draw loop regions, joins, groups and the `waiting_slot` state with `data-testid`s; verify with component tests and a story
- [ ] 5.2 Update the openwiki pipelines / automation page (graph semantics, loops, joins, groups, journal); verify its file references exist

## 6. Integration

- [ ] 6.1 Run `bun run lint`, `bun run typecheck` and the pipelines, workflows, server, runtime, orchestrator and client suites; all pass
- [ ] 6.2 End to end on the server: two factory runs of one repository with a flow whose `merge` node has `concurrency: { group: merge-{{inputs.repo}}, limit: 1 }` merge one after the other, and a server restart mid-run resumes without starting a second agent thread
