# thread-share-steer Specification

## Purpose
TBD - created by archiving change thread-sharing-steer. Update Purpose after archive.

## Requirements

### Requirement: Share grants carry a permission level

A thread share grant SHALL carry a `level` of either `view` or `steer`. `view` preserves the existing read + comment + presence access. `steer` is a strict superset of `view` plus a fixed allow-list of two additional capabilities: sending follow-up messages, and reading git state. Existing grants created before this change SHALL be treated as `view`.

#### Scenario: Legacy grant defaults to view

- **WHEN** a share grant exists with no explicit level (created before this change)
- **THEN** the system SHALL treat it as `level = view`
- **AND** the sharee SHALL retain exactly today's read + comment + presence access

#### Scenario: Owner sets the level when sharing

- **WHEN** the owner shares a thread and selects `steer`
- **THEN** the grant SHALL be stored with `level = steer`
- **AND** the sharee SHALL gain follow-up and git-read access on top of view access

### Requirement: A steer sharee can send follow-up messages

A `steer` sharee SHALL be able to `POST /api/threads/:id/message` to send a follow-up to the agent running on the owner's runner. The message SHALL be persisted with the sharee's own authorship and `source: 'user'`. A `view` sharee or non-sharee SHALL be rejected.

#### Scenario: Steer sharee sends a follow-up

- **WHEN** a `steer` sharee posts a follow-up to a running thread
- **THEN** the server SHALL authorize the request as owner-or-steer
- **AND** route it to the thread owner's runner
- **AND** the runtime SHALL persist the message attributed to the sharee with `source: 'user'`

#### Scenario: View sharee cannot steer

- **WHEN** a `view` sharee posts a follow-up
- **THEN** the request SHALL be rejected with 403
- **AND** no message SHALL be enqueued to the agent

### Requirement: A steer sharee can read git state but never write

A `steer` sharee SHALL be able to call the read-only git endpoints (`status`, `diff`, `log`) for the shared thread. All git write operations (stage, commit, stash, push, PR, and any operation using the owner's GitHub token) SHALL remain owner-only and SHALL reject a sharee.

#### Scenario: Steer sharee reads the diff

- **WHEN** a `steer` sharee requests `GET /api/git/:id/diff`
- **THEN** the server SHALL authorize it and return the owner's working-tree diff

#### Scenario: Steer sharee is blocked from git write

- **WHEN** a `steer` sharee attempts a git write (commit, push, PR, stage, or stash)
- **THEN** the request SHALL be rejected (owner-only)
- **AND** the owner's GitHub token SHALL NOT be used or exposed

### Requirement: Non-allow-listed thread actions stay owner-only

Enabling steer SHALL NOT widen any route outside the explicit allow-list (follow-up + git read). A `steer` sharee SHALL be rejected from `stop`, `approve-tool`, `upload`, `rewind`, `convert-to-worktree`, `fork`, `tool-call` updates, and all thread-admin/mutation routes, even though those requests would now reach the owner's runner.

#### Scenario: Steer sharee cannot stop the agent

- **WHEN** a `steer` sharee posts to `/api/threads/:id/stop`
- **THEN** the request SHALL be rejected
- **AND** the agent SHALL keep running

#### Scenario: Steer sharee cannot approve tool calls

- **WHEN** a `steer` sharee posts to `/api/threads/:id/approve-tool`
- **THEN** the request SHALL be rejected
- **AND** no tool execution SHALL be authorized on the owner's machine

### Requirement: Runner resolution delegates to the owner for authorized sharees, audited

For an authorized `steer` sharee, the server SHALL resolve the runner by the **thread owner's** identity rather than the requester's, as a deliberate exception to runner isolation. Every such delegated resolution SHALL emit an audit record identifying the sharee, the thread, the owner, and the action.

#### Scenario: Steer request routes to the owner's runner

- **WHEN** a `steer` sharee's allow-listed request is resolved
- **THEN** the server SHALL select the runner registered to the thread owner
- **AND** SHALL NOT fall back to any other user's runner

#### Scenario: Delegation is audited

- **WHEN** a sharee request is routed to the owner's runner
- **THEN** the system SHALL write an audit record with the sharee id, owner id, thread id, and action

### Requirement: The runtime trusts a forwarded sharee identity against the share

The runtime SHALL authorize an allow-listed sharee request against the share grant, not only against thread ownership. When the forwarded user is a `steer` sharee, the runtime SHALL accept `/message` and git-read for the thread and reject everything else.

#### Scenario: Runtime accepts a forwarded steer sharee

- **WHEN** the runtime receives a `/message` request whose forwarded identity is a `steer` sharee of the thread
- **THEN** it SHALL process the follow-up instead of rejecting it as a non-owner

#### Scenario: Runtime rejects a forwarded non-steer identity

- **WHEN** the runtime receives a non-allow-listed request whose forwarded identity is a sharee
- **THEN** it SHALL reject the request
