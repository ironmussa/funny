# Spec Delta

## Purpose

Lets one issue factory develop several features in parallel, each on its own branch (a lane),
kept close to the factory's base branch so that merging a finished feature back stays small.

## ADDED Requirements

### Requirement: A lane is named by a label on the issue

An issue SHALL select a lane by carrying a label made of the factory's lane prefix and a name
(`feature:payments`, with the prefix `feature:`; the default is `lane:`, D11), compared without regard to case. The lane's
branch SHALL be the factory's lane branch prefix followed by that name (`feature/payments`, with
the prefix `feature/`; the default is `lane/`). A member with `steer` SHALL be able to change both prefixes in the
factory's settings while the factory has no lane. The label that admits issues to the factory
SHALL still decide whether an issue is admitted; a lane label only selects the branch. Nobody
registers a lane beforehand: the factory SHALL create it when it first admits an issue that names
it, and SHALL create the lane's branch from the factory's "Merge into" branch when that branch
does not exist on GitHub. An issue whose lane label gives a branch name git does not accept, or
whose lane branch cannot be created, SHALL NOT be admitted and SHALL stay queued with the reason.
Lanes SHALL share the factory's concurrency limits.

#### Scenario: The first issue of a feature

- **WHEN** the factory admits issue #30 labelled `feature:payments`, and it has no lane `payments`
- **THEN** the factory creates the lane `payments`, creates `feature/payments` from its "Merge into" branch, and #30 runs on that branch

#### Scenario: Another issue of the same feature

- **WHEN** issue #31 is labelled `Feature:Payments` and the lane `payments` exists
- **THEN** #31 runs on `feature/payments`, and no other lane is created

#### Scenario: A lane label without the factory's label

- **WHEN** the factory admits automatically on `ready-for-agent` and an issue carries only `feature:payments`
- **THEN** the issue is not admitted and no lane is created

#### Scenario: A name that is not a branch

- **WHEN** an issue is labelled `feature:a..b`
- **THEN** it is not admitted, and the board shows that its lane name is not valid

### Requirement: A factory shows and manages its lanes

The factory's settings SHALL list its lanes with each one's label, branch, sync state and open
runs, and SHALL warn on a lane when the repository's workflows do not run for pull requests into
its branch. A member with `steer` SHALL be able to remove a lane, except while one of its runs or
its sync is in flight. The factory's "Merge into" branch SHALL NOT be changed while the factory
has lanes. A lane that was finished (see "A finished lane goes back through a person") SHALL stay
listed as finished until a member removes it, and an issue naming a finished lane SHALL run
without a lane; the name SHALL make a new lane only after the finished one was removed.

#### Scenario: Removing a lane with work in flight

- **WHEN** the enabler removes the lane `payments` while a run on `feature/payments` is in flight
- **THEN** the removal is refused with a message naming the run

#### Scenario: A mistyped label

- **WHEN** an issue labelled `feature:paymnets` was admitted and made the lane `paymnets`
- **THEN** the settings list that lane, and once its run ended the enabler can remove it

### Requirement: A run's base branch is decided at admission

When the factory admits an issue, it SHALL decide the run's base branch from the issue's labels at
that moment: the branch of the lane its lane label names, or the factory's "Merge into" branch
(else the repository's default branch) when it carries no lane label or names a finished lane. It SHALL record that
branch on the run, and every later step of the run, including a retry or a resume after a
restart, SHALL use the recorded branch. An issue carrying two or more lane labels SHALL
NOT be admitted; it SHALL stay queued with a reason naming the lanes. A run admitted before lanes
existed SHALL use the factory's "Merge into" branch.

#### Scenario: An issue in a lane

- **WHEN** issue #30 carries `feature:a`
- **THEN** #30's run starts from `origin/feature/a`, its pull request targets `feature/a`, and it merges into `feature/a`

#### Scenario: The label changes after admission

- **WHEN** #30's run is in flight on `feature/a` and a member replaces `feature:a` with `feature:b` on the issue
- **THEN** the run keeps `feature/a` as its base until it ends

#### Scenario: Two lanes at once

- **WHEN** an issue carries both `feature:a` and `feature:b`
- **THEN** it is not admitted, and the board shows that it matches two lanes

#### Scenario: Lanes merge independently

- **WHEN** a run of lane `feature/a` and a run of lane `feature/b` both reach `merge`
- **THEN** each enters the merge lane of its own branch, and neither waits for the other

### Requirement: A lane branch is kept in sync with the factory's base

While a lane exists, the factory SHALL bring its "Merge into" branch into the lane's branch when
the lane's branch does not contain that branch's head, whoever moved it, starting at most one sync
per lane an hour, and at once when a member asks for it. A sync SHALL go through a pull request
into the lane's branch, SHALL merge only when its checks pass, and SHALL be merged with a merge
commit, never squashed or rebased, so that the lane's branch contains the base's commits. Only one
sync per lane SHALL be in flight, and its merge SHALL take turns with the merges of the lane's
runs. A sync that merges without a conflict SHALL need no agent and no runner. A sync whose merge
conflicts, or whose checks fail, SHALL be handed to an agent on the enabler's runner; after three
attempts without green checks the lane SHALL show that its sync needs a person, with the pull
request, and SHALL start no other sync until a member retries it. A sync SHALL fail with the
reason when the repository does not allow merge commits. A sync SHALL NOT use a slot of the
factory's issue stages. No sync SHALL start while the "Merge into" branch has an open
incident.

#### Scenario: The base moves

- **WHEN** `dev` gets a new commit and the lane `feature/a` does not contain it
- **THEN** the factory opens a sync pull request into `feature/a` and merges it with a merge commit once its checks pass, without starting an agent

#### Scenario: The base moves several times in an hour

- **WHEN** `dev` gets three commits within the hour after a sync of `feature/a` started
- **THEN** the next sync starts once the hour has passed and brings the three commits in together

#### Scenario: A sync conflicts

- **WHEN** merging `dev` into `feature/a` conflicts
- **THEN** an agent resolves the conflict on the sync's branch, the checks run, and the sync merges only when they pass

#### Scenario: The agent cannot make the sync green

- **WHEN** the sync's checks still fail after the agent's third attempt
- **THEN** the lane shows that its sync needs a person and links the pull request, and no new sync starts for that lane

#### Scenario: Nothing to sync

- **WHEN** `feature/a` already contains `dev`'s head
- **THEN** no sync pull request is opened

### Requirement: A lane run's issue is closed when the run merges

When a run whose base branch is a lane's branch merges, the factory SHALL close the run's issue
and comment on it with the branch it merged into and that it reaches the factory's "Merge into"
branch when the lane is finished.

#### Scenario: A lane task merges

- **WHEN** #30's run merges into `feature/a`
- **THEN** #30 is closed with a comment saying it merged into `feature/a`

### Requirement: Work is not stacked across lanes

A run SHALL NOT be stacked on a blocker whose run has another base branch, whatever the factory's
`dependencies` setting. This covers a blocker in another lane and a blocker without a lane. Such a
blocker SHALL count as finished only when the commit its run merged is contained in the
candidate's base branch (for example, after its lane was finished and the candidate's lane
synced), or when it has no factory run and its issue is closed; until then the candidate SHALL
wait with the reason `blocker-on-other-branch` naming the blocker and its branch. A blocker with the
same base branch SHALL be treated as before.

#### Scenario: A blocker in another lane

- **WHEN** issue #31 in lane `feature/a` is blocked by #40 in lane `feature/b`, and the factory uses `stack`
- **THEN** #31 is not started on #40's branch and waits as `blocker-on-other-branch`

#### Scenario: The blocker merged into its own lane only

- **WHEN** #40's run merged into `feature/b` and `feature/a` does not contain that merge
- **THEN** #31 still waits as `blocker-on-other-branch`

#### Scenario: A blocker without a lane

- **WHEN** #31 in lane `feature/a` is blocked by #12, which merged into `dev`, and `feature/a` has not synced since
- **THEN** #31 waits as `blocker-on-other-branch` and is admitted after the next sync of `feature/a`

#### Scenario: The blocker reached the candidate's branch

- **WHEN** `feature/b` was merged into `dev` and the sync brought `dev` into `feature/a`
- **THEN** #31 is admitted

### Requirement: A finished lane goes back through a person

A member with `steer` SHALL be able to ask the factory to finish a lane. The factory SHALL refuse
while a run of the lane is in flight. Otherwise it SHALL open the pull request that merges the
lane's branch into the factory's "Merge into" branch, with the lane's merged issues listed and a
note that a person must review and merge it, SHALL start a sync when the lane's branch is behind,
and SHALL NOT merge that pull request, approve it, or ask for its approval. When a person has
merged it, the factory SHALL mark the lane as finished and record that it did; the branch SHALL
be left in place. An issue naming the finished lane SHALL then run without a lane.

#### Scenario: Finishing a feature

- **WHEN** the enabler asks to finish the lane `feature:a` and none of its runs is in flight
- **THEN** the factory opens `feature/a` → `dev` listing the lane's issues and leaves the merge to a person

#### Scenario: The lane's pull request merges

- **WHEN** a person merges `feature/a` → `dev`
- **THEN** the factory marks the lane `a` as finished, and a later issue labelled `feature:a` runs on `dev`

#### Scenario: Finishing with work in flight

- **WHEN** the enabler asks to finish `feature:a` while #30's run is in flight on `feature/a`
- **THEN** the request is refused with a message naming #30

### Requirement: Conflicts between lanes are reported early

The factory SHALL try, at least once a day and without writing to any branch, whether each pair of
its lane branches merges without a conflict, and SHALL show on the factory settings and the board
the pairs that conflict and the conflicting paths.

#### Scenario: Two features touch the same file

- **WHEN** `feature/a` and `feature/b` both change `src/router.ts` in ways that conflict
- **THEN** the factory shows that the two lanes conflict on `src/router.ts`, and no branch is changed

### Requirement: The board filters its runs by lane

The factory board SHALL offer a lane filter listing every lane of the factories it shows, whether
or not a run of that lane is loaded, and a "No lane" option, and SHALL show only the runs of the
selected lanes. The filter SHALL be shown whenever one of those factories has a lane, and SHALL
let a member find a lane by typing its name. Lanes of the same name in two projects SHALL be
separate options. The board's search SHALL also match a run's lane name.

#### Scenario: Seeing one feature's work

- **WHEN** the member selects the lane `payments` in the board's lane filter
- **THEN** the board shows only the runs admitted to `payments`, in every column

#### Scenario: A lane without runs on screen

- **WHEN** the factory has the lane `payments` and no loaded run belongs to it
- **THEN** the lane filter is shown and lists `payments`, and selecting it shows an empty board

#### Scenario: The same lane name in two projects

- **WHEN** projects A and B each have a lane `auth` and the member selects A's
- **THEN** the board shows the runs of A's `auth` only

#### Scenario: A factory that never had a lane

- **WHEN** no factory on the board has a lane and no loaded run has one
- **THEN** the board shows no lane filter

### Requirement: A lane's branch belongs to one factory

Before making a lane, the factory SHALL refuse a branch that an active lane of another factory of
the same project uses, keeping the issue queued with the reason. A branch that no factory uses as a
lane MAY be adopted.

#### Scenario: Two members name the same lane

- **WHEN** Bob's factory has the lane `auth` on `lane/auth`, and Alice's factory on the same project admits its first issue labelled `lane:auth`
- **THEN** Alice's issue stays queued with `lane-invalid`, saying that `lane/auth` is another factory's lane, and no lane is made

### Requirement: A send may name its own branches

A send SHALL be able to name the branch its issues run on, and, for a lane the send makes, the
branch the lane starts from and the branch it is finished into. Those branches SHALL apply to the
runs of that send only: the factory's settings and its other runs and lanes SHALL NOT change. A
lane that exists SHALL keep the branches it was made with. A send naming a branch that does not
exist on GitHub SHALL be refused and queue nothing.

#### Scenario: Issues without a lane, on another branch

- **WHEN** a factory merges into `dev`, and a member sends issue #3 naming the branch `release`
- **THEN** #3's run starts from and merges into `release`, and an issue sent without a branch still runs on `dev`

#### Scenario: A new lane with its own branches

- **WHEN** a member sends issue #1 labelled `lane:payments` naming "Starts from" `release` and "Finish into" `qa`, and the lane does not exist
- **THEN** `lane/payments` is cut from `release`, the lane syncs with `release`, and "Finish lane" opens its pull request into `qa`

#### Scenario: A lane that exists

- **WHEN** a later send names other branches for the lane `payments`
- **THEN** the lane keeps `release` and `qa`

#### Scenario: A branch that does not exist

- **WHEN** a send names the branch `relase`, which GitHub does not have
- **THEN** the send is refused with a message naming the branch, and no issue is queued

### Requirement: Lane prefixes default to the factory's own convention

A factory that never saved its lane prefixes SHALL use `lane:` for the label and `lane/` for the
branch. A factory saved before this default changed SHALL keep `feature:` and `feature/`.

#### Scenario: A team label that looks like a lane

- **WHEN** a new factory admits an issue labelled `feature:billing`
- **THEN** the issue runs on the factory's own branch and no lane is made
