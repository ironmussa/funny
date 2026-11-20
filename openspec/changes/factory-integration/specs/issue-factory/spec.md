# Spec Delta

## ADDED Requirements

### Requirement: Ready pull requests merge in tested batches

When the base branch does not require GitHub's merge queue, the system SHALL merge factory pull
requests of a repository and base branch in batches of up to the factory's batch size: it SHALL
build a temporary branch from the current base with each member merged in queue order, wait for
its checks, and merge the members in that order only when the checks are green and the base has
not moved since the batch was built. If the base moved, it SHALL rebuild the batch on the new
base. It SHALL build the batch on a staging ref that CI does not listen to and point the batch
branch at the finished commit, so CI runs once per batch. After merging it SHALL verify that the
resulting base matches the tested batch, and SHALL delete the temporary branches when the batch
ends. When the base branch requires pull requests to be up to date before merging, the system
SHALL use batches of one on it and SHALL NOT bypass the rule.

A batch SHALL be green only when the base branch's required checks, or, when it requires none,
the checks that reported on its members' pull requests, reported green on the batch commit; a
batch commit with no checks SHALL NOT count as green. The system SHALL merge a member only at the
head commit the batch tested, and SHALL rebuild the batch without a member whose run was stopped
or taken over or whose pull request head changed. When a member's merge is refused after earlier
members merged, the system SHALL stop merging that batch, record it, and test the remaining
members again on the new base.

#### Scenario: A green batch merges in one CI run
- **WHEN** runs #12, #13 and #14 wait to merge and the batch branch with all three is green
- **THEN** the three pull requests are merged in that order and only one CI run on the batch was needed

#### Scenario: Someone merges by hand during a batch
- **WHEN** the base moves while a batch's checks are running
- **THEN** no member is merged and the batch is rebuilt on the new base

#### Scenario: A branch that must be up to date before merging
- **WHEN** the base branch requires pull requests to be up to date and #12 and #13 are ready
- **THEN** #12 is updated, checked and merged on its own, then #13, and the readiness check says why batches are of one

#### Scenario: CI does not start on the batch branch
- **WHEN** no check reports on a batch commit
- **THEN** the batch is not merged, no member is sent back to its implementer, and the readiness check says CI did not run on the queue branch

#### Scenario: Someone pushes to a member's pull request during the batch
- **WHEN** #13's pull request gets a new commit while the batch of #12, #13 and #14 is being tested
- **THEN** #13 is not merged on that result and the batch is rebuilt with #12 and #14

#### Scenario: The run that leads a batch is stopped
- **WHEN** a member stops the run that is leading a batch of three
- **THEN** that run leaves the queue, and the other two wait again and are tested in a new batch

#### Scenario: A merge is refused in the middle of a batch
- **WHEN** #12 merged from a green batch and GitHub refuses to merge #13
- **THEN** #14 is not merged, the partial landing is recorded, and #13 and #14 are tested again on the new base

#### Scenario: A member that does not merge onto the batch
- **WHEN** #13 conflicts with the batch built from the base and #12
- **THEN** #13 leaves the batch and goes to the integrate step, and the batch continues with the others

### Requirement: A red batch is bisected

When a batch's checks are red, the system SHALL test the same tree once more and continue as
green if it passes. If still red, it SHALL test halves of the batch on their own branches from the same
base, in parallel, splitting every red half again until each member that makes the checks fail is
isolated; those members SHALL go back to their implementers with the failure. The other members
SHALL NOT merge on the result of their halves: they SHALL form a new batch that is built and
tested again before merging. When no half is red, the system SHALL split the batch into batches
of one.

#### Scenario: One member breaks the batch
- **WHEN** a batch of #12, #13 and #14 is red because of #14
- **THEN** the halves are tested, #14 goes back to its implementer with the failing checks, and #12 and #13 merge only after a new batch of the two is green

#### Scenario: Two members break the batch
- **WHEN** a batch of #12, #13, #14 and #15 is red because of #12 and #15
- **THEN** both halves are bisected, #12 and #15 go back to their implementers, and #13 and #14 form a new batch

#### Scenario: A flaky failure
- **WHEN** a batch is red and the second test of the same tree is green
- **THEN** the batch merges without bisection and the flake is counted in the run metrics

#### Scenario: Two members that only fail together
- **WHEN** a batch is red but both of its halves are green
- **THEN** its members are tested and merged as batches of one, in queue order

#### Scenario: A batch of one
- **WHEN** a batch with only #12 is red
- **THEN** #12 goes back to its implementer with the failing checks and no bisection runs

### Requirement: GitHub's merge queue is used only when required

The system SHALL hand factory pull requests to GitHub's merge queue only when the base branch's
rules require it, and SHALL otherwise use its own batches. It SHALL read the rules when each batch
starts.

#### Scenario: A repository that requires GitHub's merge queue
- **WHEN** the base branch's rules require the merge queue
- **THEN** the pull request is added to GitHub's merge queue and followed, and no funny batch is built

#### Scenario: A repository without that rule
- **WHEN** the base branch does not require the merge queue
- **THEN** funny's own batches are used

### Requirement: Conflicts are resolved deterministically before an agent

On a conflict with the base branch, the system SHALL first run an integrate step in the run's
worktree or sandbox: merge the base in (never a rebase) with the structural merge driver and
recorded resolutions, regenerate declared paths, run the declared integration checks and push.
Only a conflict that remains after that SHALL be sent to the implementer, with the conflicted
paths and the diff of the pull request that merged in between. A round that the integrate step
resolved SHALL NOT count against the run's limit of correction rounds. The merge driver and
recorded resolutions SHALL be configured for the run's own processes only; the system SHALL NOT
write them to the configuration of the user's repository.

#### Scenario: Adjacent additions resolved without an agent
- **WHEN** two runs added different imports next to each other in the same file and the structural driver merges them
- **THEN** the integrate step pushes the merge and the implementer is not asked

#### Scenario: Several resolved rounds do not park the run
- **WHEN** the integrate step resolves a conflict for the same run four times without the implementer
- **THEN** the run is not parked for exhausted rounds

#### Scenario: A worktree run leaves the user's git configuration alone
- **WHEN** the integrate step runs in a worktree of the user's local repository
- **THEN** the repository's git config and attributes files are unchanged afterwards

#### Scenario: A resolved conflict is reviewed again
- **WHEN** the integrate step resolved a conflict with the structural driver or a regenerator
- **THEN** the run passes the review gate again, with the reviewer limited to the resolved hunks and regenerated paths

#### Scenario: A clean merge of the base
- **WHEN** the integrate step merged the base in without any conflict
- **THEN** the earlier review still holds

#### Scenario: A real conflict
- **WHEN** both runs changed the same function body differently
- **THEN** the integrate step aborts the merge and the implementer receives the conflicted paths and the other pull request's diff

### Requirement: Declared paths are regenerated, never merged

The system SHALL read regenerators from `.funny/integrate.yaml` on the default branch, each a set
of paths and a command. When an integration conflict touches a declared path, the system SHALL
run that path's command in the run's worktree or sandbox and use its output, instead of merging
the file or asking an agent. A regenerator file that does not validate SHALL be reported when the
flow is validated and when a run loads it.

#### Scenario: A lockfile conflict
- **WHEN** `bun.lock` conflicts and `.funny/integrate.yaml` declares `bun.lock` → `bun install`
- **THEN** `bun install` runs in the run's worktree, its lockfile is used, and no agent is asked

### Requirement: Factory flows may run commands in the run's own workspace

The system SHALL accept `run_command` steps in factory flows read from the default branch, and
SHALL run them only in the run's own worktree or sandbox on the enabler's runner, never on the
server, with a timeout (10 minutes unless the step sets one), recording the command's output on
the run, bounded, with the values of the secrets in the step's environment masked, and failing
the step on a non-zero exit or the timeout.

#### Scenario: A codemod step
- **WHEN** a flow's step runs `bunx oxlint --fix` and it exits 0
- **THEN** it ran in the run's worktree and its output is recorded on the run

#### Scenario: A command that prints its environment
- **WHEN** a `run_command` step runs `env`
- **THEN** the recorded output shows the App installation token masked

#### Scenario: A command that hangs
- **WHEN** a `run_command` step is still running after its timeout
- **THEN** its process is killed and the step fails with the timeout as the reason

### Requirement: Regenerable changes are re-run on the new base

A flow MAY mark its `merge` step with the step that produces the change. When such a run hits an
integration conflict, the system SHALL re-run that step on the current base instead of the
integrate step or the implementer, and SHALL put such runs in a batch of their own.

#### Scenario: A repository-wide lint fix
- **WHEN** a run whose change comes from `oxlint --fix` conflicts with a merge that landed before it
- **THEN** the command runs again on the new base, the result is pushed, and no conflict is resolved by hand

### Requirement: Runs are integrated early when a merge affects them

When a pull request merges into a repository, the system SHALL check, without pushing or running
checks, whether the factory runs in flight whose changed paths overlap it still merge, and SHALL
run the integrate step on those that no longer do, before they reach the merge queue. It SHALL
NOT run the integrate step in a worktree or sandbox while an agent step or command of that run
is active: it SHALL run it when that step ends. A run that is waiting for its checks SHALL be
judged on the new head.

#### Scenario: A conflict found while the implementer is still working
- **WHEN** #12 merges and run #13, still being reviewed, no longer merges cleanly
- **THEN** the integrate step runs on #13 then, and any remaining conflict goes to its implementer before #13 reaches the queue

#### Scenario: A merge that affects a run waiting for its checks
- **WHEN** #12 merges and the integrate step pushes a merge commit to run #13 while it waits for CI
- **THEN** #13 waits for the checks of the new head and the old head's checks decide nothing

#### Scenario: A merge that affects a run whose agent is working
- **WHEN** #12 merges and the implementer of run #13 is still editing its worktree
- **THEN** #13 is marked for integration and the integrate step runs when the implementer's step ends, not during it

### Requirement: Dependent issues can be stacked

A factory SHALL support `dependencies: wait` (the default: an issue waits until its blockers are
finished) and `dependencies: stack`. With `stack`, an issue whose blocker has a run in flight with
a branch SHALL start on top of the blocker's branch with its pull request against it; the queue
SHALL merge the blocker first, and the stacked run SHALL park in `waiting_human` if the blocker's
run fails or is stopped or its pull request is closed without merging. The system SHALL bring
each new commit of the blocker's branch into the runs stacked on it, SHALL NOT put a stacked run
in the same batch as its blocker, and, once the blocker merged, SHALL retarget the stacked pull
request to the base branch and bring the base in before the run enters the queue.

#### Scenario: Work on a dependent issue starts early
- **WHEN** issue #21 is blocked by #20, #20's run is in flight, and the factory uses `stack`
- **THEN** #21's implementer starts on #20's branch instead of waiting for #20 to merge

#### Scenario: The blocker is squash-merged
- **WHEN** #20 is squash-merged while #21 is stacked on it and already contains #20's last commit
- **THEN** #21's pull request is retargeted to the base branch, the base merges into it without a conflict from #20's own changes, and #21 then enters the queue

#### Scenario: The blocker gets a fix after the stacked run started
- **WHEN** #20's implementer pushes a review fix while #21 is stacked on it
- **THEN** the fix is merged into #21's branch by the integrate step, not left for merge time

#### Scenario: The blocker fails
- **WHEN** #20's run fails while #21 is stacked on it
- **THEN** #21 parks in `waiting_human` with the blocker's failure as the reason

### Requirement: The queue orders and groups its members

The merge queue SHALL take a blocker before the runs stacked on it or blocked by it, then
admission order, letting a much smaller change go before a much larger one, and SHALL prefer
batches whose members change disjoint paths.

#### Scenario: A small fix behind a large refactor
- **WHEN** a 30-line fix and a 900-line refactor wait to merge and neither blocks the other
- **THEN** the fix is taken first

### Requirement: The factory shows whether a repository is ready for the queue

The factory settings SHALL show, per repository, whether its CI runs on the queue's temporary
branches, whether a structural merge driver is available on the enabler's runner, its median CI
time against the batch wait, whether its base branch requires GitHub's merge queue, and whether
it requires pull requests to be up to date before merging (batches of one). When CI
does not run on the temporary branches, the system SHALL NOT start batches for that repository,
SHALL say why, and SHALL offer to open a pull request that adds the trigger.

#### Scenario: CI does not run on the queue's branches
- **WHEN** a repository's workflows do not trigger on `factory/queue/**`
- **THEN** the settings show it, no batch starts, and the member can open the pull request that adds the trigger

### Requirement: Integration is measured per run and per factory

Each run SHALL record integrate rounds, conflicts resolved without an agent, conflicts sent to the
implementer, its queue wait, the size of the batch that merged it, its bisection rounds and the
batch failures that passed on a second test, in addition to its CI counters. Counters missing from older runs SHALL read as 0. The factory's
30-day summary SHALL show conflicts resolved without an agent, the median queue wait, the average
batch size and the share of batches that needed bisection.

#### Scenario: A conflict resolved by the structural driver
- **WHEN** the integrate step resolves a conflict without the implementer
- **THEN** the run's count of conflicts resolved without an agent goes up by one and the summary includes it
