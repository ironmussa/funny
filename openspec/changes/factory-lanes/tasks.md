# Tasks

Phase 1 is groups 1–8: lanes usable in parallel, kept in sync, and finished through a person.
Phase 2 is groups 9–10. Phase 3 is group 11. Group 12 closes each phase.

## 1. Schema

- [x] 1.1 Add nullable `factory_runs.base_branch` and `factory_runs.merge_sha`, and `factory_settings.lane_label_prefix` (default `feature:`) and `lane_branch_prefix` (default `feature/`), and the `factory_lanes` table (`factory_id`, `name`, `branch`, `state` default `active`, `ci_warning`, `created_at`, `sync_state` default `idle`, `sync_base_sha`, `sync_pr_number`, `sync_thread_id`, `sync_attempts`, `sync_turn_at` (migration 139), `sync_started_at`, `sync_error`, `last_synced_base_sha`, `finish_pr_number`; unique on `(factory_id, name)`) to `schema-sqlite/factory-tables.ts`, `schema.pg.ts` and `db/migrate.ts`; verify the migration test and a fresh `bun run db:push` on SQLite and PostgreSQL create them
- [x] 1.2 Map the new run columns in the factory run repository and the run view contract (`@funny/shared/contracts/factory`: `baseBranch` on the run); verify the run mapping tests

## 2. Base branch frozen on the run (D2, D3)

- [x] 2.1 Add an optional `baseBranch` to `FactoryRepoReader` and make `reads(reader)` in `factory-github.ts` prefer it over `factoryBaseBranchOf`; verify a unit test where a reader with `baseBranch` answers it from `defaultBranch()` and `branchAhead`
- [x] 2.2 Write `base_branch` in the admission compare-and-set (watcher and manual queue), resolved from the factory's setting (no lanes yet); verify a test that a run admitted while the factory merges into `develop` keeps `develop` after the setting changes to `main`
- [x] 2.3 Build the action provider's and `factory-flow-runs.ts`'s reader from the run's `base_branch` (null → factory setting), so the worktree start, triage/review checkouts, integrate, stacking, `create_pr`'s retarget and the merge lane name use it; verify the existing factory flow tests pass and a new resume test keeps the recorded base
- [x] 2.4 Read a merged run's merge commit from its pull request (`merge_commit_sha`) the first time a dependency on another branch needs it, and keep it in `factory_runs.merge_sha` (done with 5.1; no write in the merge paths, so a batch, GitHub's merge queue and a person's merge are covered alike); verify a test that the commit is read once and reused
- [x] 2.5 Record the lane a run was admitted to (`factory_runs.lane`) and show its base as a `BranchBadge` on the run card when it has one; verify a component test
- [x] 2.6 Update the "merge into" section of `openwiki/architecture/issue-factory.md` to say the base is frozen on the run; verify the doc names `factory_runs.base_branch`

## 3. Lane convention and management (D1)

- [x] 3.1 Add a pure `resolveLane(labels, prefixes)` (case-insensitive; answers no lane, one lane with its name and branch, `lane-ambiguous`, or `lane-invalid` through `factoryBaseBranchSchema`, also for a branch equal to "Merge into" or the default branch); verify unit tests for each answer
- [x] 3.2 Add the two prefixes to the factory settings (needs `steer`; refused while the factory has lanes), lane reads and lane removal to `factory-settings.ts` (removal refused while a run with its base or its sync is in flight), and refuse changing "Merge into" while the factory has lanes; verify a test for each refusal and its message
- [ ] 3.3 Expose the prefixes in the settings procedures and `factory.lanes.list/remove` in `@funny/api` and `trpc/ports/factory.ts`, with contracts in `@funny/shared/contracts/factory`; verify router tests for 403 without `steer` and 404 for another user's factory
- [ ] 3.4 Add the prefixes and the lanes list (label, branch, state, open runs, CI warning, remove) to Settings > project > Factory (`data/factory/`, shadcn components, `data-testid`s, i18n en/es/pt, entries in `settings-index.ts`), with the text that an issue needs the factory's label and a `feature:<name>` label; verify a component test and `bun run lint` (settings-index, client-data-layer)

## 4. Admission picks and creates the lane (D1, D2)

- [x] 4.1 At admission (watcher and `factory-queue.ts` sends), resolve the lane with `resolveLane`, insert the lane row if missing, create a missing branch from the "Merge into" head with the App token and write the branch as the run's `base_branch`; verify tests with the fake GitHub for: first issue (lane and branch created), second issue (reused, other case), no lane label, lane label without the factory's label (not admitted, nothing created), a label changed after admission, and two admissions racing (one lane)
- [x] 4.2 Keep an issue queued with `lane-ambiguous` (two lane labels) or `lane-invalid` (bad name, or the branch cannot be created), with the reason (contract, board label, i18n); verify watcher tests and a board test that shows each reason
- [x] 4.3 Route an issue naming a `finished` lane to "Merge into"; verify a watcher test
- [ ] 4.5 When a lane is made, read the workflows' `pull_request` / `push` branch filters and store a warning on the lane when they exclude its branch; verify tests with the fake GitHub for a filter that excludes the branch and one that includes it
- [ ] 4.4 Verify, with a flow-runs test, that two runs of different lanes reach `merge` at once and each takes its own merge lane (`merge:<repo>:feature/a`, `merge:<repo>:feature/b`)

## 5. Dependencies across branches (D5)

- [x] 5.1 Pass each blocker run's `baseBranch`, `mergeSha` and "contained in the candidate's base" (GitHub compare, cached per tick) to `factory-dependencies.ts`, and add `blocker-on-other-branch` (contract, board label, i18n); verify the pure tests for: same base (unchanged), other lane not contained, unlaned blocker not yet synced into the lane, other base contained, blocker closed without a run
- [x] 5.2 Make `factory-stacking.ts` refuse a blocker with another base before stacking; verify a stacking test where `stack` mode does not stack across lanes

## 6. Lane sync (D4)

- [x] 6.1 Add `factory-lane-sync.ts` with the transition table of D4 as a pure function and compare-and-set writes on `factory_lanes.sync_state`; verify pure tests of every transition and a test that two concurrent starts yield one sync
- [x] 6.2 Implement `merging` on the server: create `factory/sync/<name>` from the lane head, GitHub merge API with the base sha, open the pull request into the lane on 201, go to `resolving` on 409; verify tests with the fake GitHub for clean, conflict, and "already contains the base" (no pull request)
- [x] 6.3 Implement `checking`: read the head's checks with `createPullRequestCi`, merge with the `merge` method while holding the group `merge:<repo>:<lane branch>`, set `last_synced_base_sha`; go to `needs_human` with the reason when the repository refuses merge commits; verify tests for green, red, the refused method, and a sync and a lane run not merging at the same time
- [x] 6.4 Implement `resolving`: one thread on the enabler's runtime through `startThreadOnRunner` (worktree on the sync branch, built-in prompt), follow-ups on the same thread for later attempts, the "sync branch contains `sync_base_sha`" check when the thread ends, and `needs_human` after three attempts; verify tests with the fake runner for resolved, not pushed, and attempts used up
- [x] 6.5 Start syncs from the watcher tick (state `idle`, base head moved, not contained, last start over an hour ago) and resume a sync in flight after a restart from the lane row; verify tests for the trigger, the hour, and a restart in each state
- [ ] 6.6 Expose `requestLaneSync` (done in `factory-settings.ts`: sync now for an idle lane, retry for one that needs a person; needs `steer`) as `factory.lanes.sync`, show each lane's sync state, error and pull request in the lanes table, and record a `factory.lane_sync` activity per transition; verify port tests, a component test, and the activity rows
- [x] 6.7 Verify that a sync takes no slot of the factory's issue stages, with a watcher test that admits an issue while a sync is `resolving`

## 7. Closing a lane run's issue (D9)

- [ ] 7.1 When a run whose base is a lane's branch merges, close its issue and comment with the branch; leave runs without a lane as they are; verify tests for a lane run (closed, commented), an unlaned run on a non-default "Merge into" (untouched), and a close that GitHub refuses (the run still ends as merged, the failure is recorded)

## 8. Finishing a lane (D8)

- [ ] 8.1 Add `factory.lanes.finish` (needs `steer`): refuse while a run of the lane is in flight, open `lane → Merge into` with the lane's merged issues listed and the note that a person merges it, start a sync when the lane is behind, store `finish_pr_number`, record a `factory.finish_lane` activity; verify port tests with the fake GitHub for opened, refused, and already open (same pull request returned)
- [ ] 8.2 On the watcher tick, mark a lane `finished` (compare-and-set from `active`) when its finish pull request merged, stop its syncs, and record the activity; verify a watcher test
- [ ] 8.3 Add the "Finish lane" action and the link to its pull request to the lanes table; verify a component test
- [ ] 8.4 Document lanes in `openwiki/architecture/issue-factory.md` and the user-facing factory guide: the `feature:<name>` convention and the two labels, the frozen base, sync and the merge-commit requirement, `blocker-on-other-branch`, issue closing, finishing; add the `factory-lane-sync` machine to `docs/architecture/state-machines.md`; verify the docs name each of them

## 9. Sentinel per base (D6)

- [ ] 9.1 Make the sentinel tick iterate the distinct base branches of the repository's factory merges in the last 24 hours; verify a sentinel test where `feature/a` turns red and opens an incident for `feature/a` only
- [ ] 9.2 Make admission check only the incidents of the candidate's base, and make `blockedReason` per base; verify a watcher test where `feature:b` and unlaned issues are admitted during a `feature/a` incident
- [x] 9.3 Do not start a sync into a lane while the "Merge into" branch has an open incident; verify a sync test

## 10. Board

- [ ] 10.1 Show the run's lane as a `LabelBadge` on the run card and add a lane filter to the board's view toggles; verify component tests and `bun run lint`

## 11. Conflict check between lanes (D7)

- [ ] 11.1 Add a read-only runner job that fetches the lane branches and runs `git merge-tree --write-tree --name-only` per pair, reporting `unavailable` with git older than 2.38; verify a runtime test on a temp repository with two conflicting branches, and that no branch or worktree was written
- [ ] 11.2 Run it daily per factory with two or more lanes, store the pairs and paths, and show them in the lanes table and on the board; verify a server test and a component test

## 12. Integration

- [ ] 12.1 Run `bun run lint`, `bun run typecheck` and the factory test suites; verify all pass
- [ ] 12.2 Run an end-to-end scenario on the fake GitHub: two lanes, an issue in each and one unlaned, a commit on `dev` syncing both lanes (one clean, one through the agent), a cross-lane blocker admitted only after its lane is finished and the other synced, and the finished lane removed; verify the run states, branches and closed issues match the specs
