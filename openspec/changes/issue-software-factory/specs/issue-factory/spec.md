# Spec Delta

## Purpose

Turns issues that are ready for an agent into draft pull requests, follows their CI
until they are ready for review or merged, and does it as one user's standalone
process that acts on GitHub only through that user's GitHub App.

## ADDED Requirements

### Requirement: The factory is a standalone process configured from a file

The factory SHALL run as its own process, started on its own, without a funny server.
It SHALL read its settings from a configuration file and its secrets (model
credential, Factory App id and private key, sandbox provider credential) only from
the environment or an interactive prompt at startup, and SHALL never write a secret
to the configuration file, its database or its logs.

#### Scenario: Valid start

- **WHEN** the factory starts with a valid configuration file and all secrets
- **THEN** it begins watching the configured projects

#### Scenario: Invalid configuration

- **WHEN** the configuration file is missing a required field or names an unknown
  workspace kind
- **THEN** the factory does not start and names the field that is wrong

#### Scenario: Missing secret

- **WHEN** a secret needed by a configured project is not given at startup
- **THEN** the factory does not start and names the missing secret

#### Scenario: Secret in the configuration file

- **WHEN** the configuration file contains a field that looks like a token or key
- **THEN** the factory does not start and says that secrets must be given at startup

### Requirement: Ready issues are admitted

For each watched project, the factory SHALL periodically look for open issues that
carry the ready label, were opened by the configured GitHub user, are assigned to that
user or to nobody, are not blocked by an open issue and have no active factory run,
and SHALL admit them oldest first while the concurrency and daily limits allow. It
SHALL create the ready and in-progress labels in the repository when they are missing.

#### Scenario: Ready issue is admitted

- **WHEN** an open issue opened by the configured user has the ready label, no
  assignee, no run and the factory is under its limits
- **THEN** a factory run is created for it and work starts

#### Scenario: Issue opened by someone else

- **WHEN** a ready issue was opened by another GitHub user
- **THEN** it is not admitted

#### Scenario: Issue assigned to someone else

- **WHEN** a ready issue is assigned to a user other than the configured one
- **THEN** it is not admitted

#### Scenario: Blocked issue

- **WHEN** a ready issue is blocked by an issue that is still open
- **THEN** it is not admitted until the blocking issue is closed

#### Scenario: Concurrency limit reached

- **WHEN** as many runs are working as the concurrency limit allows
- **THEN** further ready issues wait and are admitted, oldest first, as slots free up

#### Scenario: Daily limit reached

- **WHEN** the factory has started its maximum number of runs today
- **THEN** no further run starts until the next day, and `status` says why

#### Scenario: Labels missing

- **WHEN** a watched repository has no in-progress label
- **THEN** the factory creates it before claiming the first issue

### Requirement: One active run per issue

The factory SHALL keep at most one active factory run per issue.

#### Scenario: Issue seen twice

- **WHEN** an issue with an active run is still labelled ready on the next poll
- **THEN** no second run is created

### Requirement: The issue shows that it was claimed

When a run starts, the factory SHALL assign the issue to the configured user, add the
in-progress label, remove the ready label and comment that the factory is working on
it.

#### Scenario: Claim

- **WHEN** a run starts for an issue
- **THEN** the issue is assigned to the configured user, carries the in-progress label
  and not the ready label, and has a comment from the Factory App

#### Scenario: Claim cannot be written

- **WHEN** the Factory App cannot change the issue
- **THEN** the run fails as an infrastructure failure and no work starts

### Requirement: Work runs in a sandbox by default

Each project SHALL run its factory runs in a sandbox unless its configuration selects
a worktree. A sandbox SHALL be created from funny's runner template for the configured
provider. The factory SHALL never fall back from a sandbox to a worktree.

#### Scenario: Sandbox project

- **WHEN** a run starts for a project without a workspace kind
- **THEN** it works in a new sandbox, and the user's machine has no checkout for it

#### Scenario: Worktree project

- **WHEN** a run starts for a project configured with `workspace: worktree`
- **THEN** it works in a new worktree of the project's local repository on branch
  `issue/<n>-<slug>`

#### Scenario: Sandbox cannot start

- **WHEN** the sandbox provider fails to create or start the sandbox
- **THEN** the run fails as an infrastructure failure and no worktree is created

### Requirement: GitHub is reached only through the Factory App

The factory SHALL reach GitHub only with installation tokens of its Factory App,
limited to the run's repository, and SHALL renew a run's token before it expires
without restarting the agent. It SHALL NOT use a personal access token or the user's
`gh` login. In worktree mode it SHALL give `gh` and git a configuration directory of
the run's own.

#### Scenario: Run longer than a token

- **WHEN** a run lasts longer than one hour
- **THEN** its git and `gh` commands keep working with a renewed token

#### Scenario: App not installed on a repository

- **WHEN** a watched repository does not have the Factory App installed
- **THEN** the factory admits nothing for it and `status` says the App must be
  installed there

#### Scenario: Worktree run leaves the user's login alone

- **WHEN** a worktree run finishes
- **THEN** the user's own `gh` configuration and git credentials are unchanged

### Requirement: Only the configured user's text reaches the agent

The prompt SHALL contain the issue title and body and only those comments written by
the configured GitHub user.

#### Scenario: Comment from another user

- **WHEN** an admitted issue has comments from other users
- **THEN** those comments are not in the prompt

### Requirement: A run opens a draft pull request

A run SHALL implement the issue, run the project's check command if it has one, commit
with the configured author, push the branch and open a draft pull request against the
project's base branch whose body closes the issue.

#### Scenario: Success

- **WHEN** the agent finishes and the checks pass
- **THEN** a draft pull request with `Closes #<n>` targets the base branch
- **AND** the issue has a comment linking it

#### Scenario: Checks fail

- **WHEN** the checks still fail after the agent's attempts in the workspace
- **THEN** no pull request is opened and the run fails as an agent failure

#### Scenario: Nothing to push

- **WHEN** the agent made no changes
- **THEN** no pull request is opened and the run fails as an agent failure

#### Scenario: No check command

- **WHEN** the project has no check command
- **THEN** the pull request is opened without local checks and its body says so

### Requirement: The factory follows the pull request's CI

After opening the pull request, the factory SHALL poll its checks every 3 minutes. When
a check fails or the pull request conflicts with its base, it SHALL ask the same agent,
with the failing checks' names and log excerpts or the conflict, to fix it and push,
up to 3 attempts in total for the run. Waiting for CI SHALL NOT count against the
concurrency limit; a fix attempt SHALL.

#### Scenario: CI fails once

- **WHEN** a check of the pull request fails
- **THEN** the agent receives the failure, pushes a fix, and the factory polls again

#### Scenario: Conflict with the base

- **WHEN** the pull request conflicts with its base branch
- **THEN** the agent rebases onto the base and pushes, as one fix attempt

#### Scenario: Attempts exhausted

- **WHEN** CI still fails after 3 fix attempts
- **THEN** the run fails as an agent failure, with a comment on the pull request and
  the issue

#### Scenario: Waiting does not hold a slot

- **WHEN** the concurrency limit is 1 and a run is waiting for CI
- **THEN** another ready issue can be admitted

### Requirement: Green CI ends the run, optionally with a merge

When the pull request's checks pass, the factory SHALL mark it ready for review. If
auto-merge is enabled, it SHALL enable GitHub's auto-merge (squash when the repository
allows it, otherwise its allowed method) and SHALL never bypass branch protections.

#### Scenario: Auto-merge off

- **WHEN** CI passes and auto-merge is disabled
- **THEN** the pull request is ready for review, not merged, and the run succeeds

#### Scenario: Auto-merge on, no review required

- **WHEN** CI passes, auto-merge is enabled and the base branch requires no review
- **THEN** the pull request is merged

#### Scenario: Auto-merge on, review required

- **WHEN** CI passes, auto-merge is enabled and the base branch requires an approval
- **THEN** the pull request waits for the approval and merges after it, without the
  factory bypassing the rule

### Requirement: Workspaces are paused while waiting and removed at the end

While a run waits for CI, the factory SHALL stop its sandbox when the provider keeps
the disk on stop, and destroy it otherwise, recreating it from the pull request's
branch when a fix is needed. When a run ends, the factory SHALL destroy its sandbox or
remove its worktree; after a confirmed merge it SHALL also delete the remote branch.

#### Scenario: Waiting for CI on a provider that keeps the disk

- **WHEN** a run starts waiting for CI in a sandbox whose provider keeps the disk
- **THEN** the sandbox is stopped, and resumed if a fix is needed

#### Scenario: Merge confirmed

- **WHEN** the pull request of a run is merged
- **THEN** its sandbox or worktree and its remote branch no longer exist

#### Scenario: Run failed

- **WHEN** a run fails
- **THEN** its workspace is removed and its branch and pull request are kept

### Requirement: Failures are retried or handed back

An infrastructure failure (sandbox, network, GitHub API, token) SHALL be retried
automatically up to 2 times, after the configured delay and then twice that delay. An
agent failure, or an infrastructure failure after its retries, SHALL hand the issue
back: remove the in-progress label, leave the ready label off, and comment with the
reason. Adding the ready label again SHALL make the issue eligible for a new run.

#### Scenario: Sandbox provider down

- **WHEN** a run fails because the sandbox provider is unreachable
- **THEN** it is retried after the configured delay

#### Scenario: Agent failure

- **WHEN** a run fails because its checks do not pass
- **THEN** it is not retried and the issue has a comment saying why

#### Scenario: Retry by a person

- **WHEN** a person adds the ready label to an issue whose run failed
- **THEN** a new run can be admitted for it

### Requirement: Runs survive a restart

The factory SHALL keep its runs in a local database and, on start, SHALL reconcile them
with GitHub and the workspaces so that no run is lost or duplicated.

#### Scenario: Restart while waiting for CI

- **WHEN** the factory restarts while a run waits for CI
- **THEN** it resumes polling that pull request

#### Scenario: Pull request merged while the factory was down

- **WHEN** a run's pull request was merged while the factory was stopped
- **THEN** on start the run is recorded as merged and its workspace is cleaned up

#### Scenario: Workspace lost

- **WHEN** a working run's sandbox no longer exists on start
- **THEN** the run fails as an infrastructure failure and follows the retry rule

### Requirement: Runs are visible and reportable

The factory SHALL provide a `status` command that lists runs with their issue, state,
pull request and the reason for any wait or failure, and SHALL write each run's
events (agent messages, tool calls, status changes, result) to a file, in the shape of
funny's ingest events, through a reporter interface that other destinations can
implement.

#### Scenario: Status

- **WHEN** the user runs `status`
- **THEN** every active run and the runs of the last day are listed with their state

#### Scenario: Event file

- **WHEN** a run's agent sends a message or calls a tool
- **THEN** an event with the run's id is appended to that run's event file
