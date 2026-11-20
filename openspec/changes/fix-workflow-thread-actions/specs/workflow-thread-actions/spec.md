# Spec Delta

## Purpose

Defines how workflow actions behave when a workflow runs for a thread: which
workspace an agent step works in, and which options the pull request action honors.

## ADDED Requirements

### Requirement: Agent steps run in the thread's workspace

When a workflow runs for a thread, every agent step of that workflow SHALL work in
the same directory and on the same branch as that thread. For a worktree thread
this is the thread's worktree, never the project's main checkout.

#### Scenario: Agent step of a worktree thread

- **WHEN** a workflow runs for a worktree thread and reaches an agent step
- **THEN** the files the agent changes are in the thread's worktree
- **AND** the project's main checkout has no changes from that step

#### Scenario: Agent step of a local thread

- **WHEN** a workflow runs for a local thread and reaches an agent step
- **THEN** the agent works in the project directory, as before

#### Scenario: Thread whose worktree is missing

- **WHEN** a workflow runs for a worktree thread whose worktree no longer exists
- **THEN** the agent step fails with an error naming the missing worktree
- **AND** no agent runs in the project's main checkout

### Requirement: Pull request action honors base and draft

The pull request action SHALL open the pull request against the `base` branch the
workflow gives it and SHALL open it as a draft when the workflow sets `draft: true`.
Without `base` it SHALL use the thread's base branch; without `draft` it SHALL open
a regular pull request.

#### Scenario: Draft pull request against a named base

- **WHEN** a workflow runs `create_pr` with `base: develop` and `draft: true`
- **THEN** the pull request targets `develop` and is a draft

#### Scenario: Defaults

- **WHEN** a workflow runs `create_pr` without `base` or `draft`
- **THEN** the pull request targets the thread's base branch and is not a draft

### Requirement: Pull request action reports the pull request

The pull request action SHALL give the workflow the URL of the pull request it
opened, so later steps can use it.

#### Scenario: Later step reads the URL

- **WHEN** `create_pr` succeeds and a later step references its output
- **THEN** the step receives the pull request URL
