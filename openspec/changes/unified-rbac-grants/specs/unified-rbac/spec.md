# Unified RBAC — Resource Grants

## ADDED Requirements

### Requirement: Single grant record per subject per resource

The system SHALL store all project- and thread-level access grants in one table
`resource_grants` keyed on `(subject_id, resource_type, resource_id)`, with a
single canonical `role`. A repeat grant for the same key SHALL update the existing
row, not create a duplicate.

#### Scenario: Re-granting is idempotent

- **WHEN** a grant `(user U, thread T, contributor)` already exists
- **AND** the owner grants `(U, T, viewer)` again
- **THEN** the row's role becomes `viewer` and no second row is created

#### Scenario: Org grants remain backed by Better Auth

- **WHEN** the resolver reads a user's role on an organization
- **THEN** it reflects the user's Better Auth `member` row (adapted as a virtual
  `org` grant), and writing an org role goes through Better Auth, not a direct
  `resource_grants` insert

### Requirement: Canonical role lattice with ranks

The system SHALL expose one role enum `{owner, admin, contributor, viewer}` with a
total rank order `owner > admin > contributor > viewer`. UI labels MAY differ per
resource type (thread `contributor`→"Steer", `viewer`→"View") but the stored and
compared value SHALL be the canonical role.

#### Scenario: Legacy thread levels map to the lattice

- **WHEN** a pre-migration `thread_shares` row has `level='steer'`
- **THEN** the resolver treats it as role `contributor`
- **AND** a `level='view'` row maps to `viewer`

### Requirement: Access is explicit — no cross-resource inheritance

The effective role of a user on a resource SHALL be the maximum (by rank) of the
explicit grant on THAT resource and `owner` if the user created it. Roles SHALL
NOT inherit across resources: org membership grants nothing on a project, and
project membership grants nothing on a thread. Threads are private and accessible
only to their owner and to holders of an explicit thread grant.

#### Scenario: A project member has no access to the project's threads

- **WHEN** user U has an `admin` grant on project P
- **AND** thread T belongs to P with no explicit grant for U
- **THEN** `effectiveRole(U, T)` is `null` and U is denied (404) on T

#### Scenario: An org admin has no access to the org's projects or threads

- **WHEN** user U has an `admin` grant on org O
- **AND** project P's owning org is O
- **THEN** `effectiveRole(U, P)` is `null` (org membership does not cascade)

#### Scenario: An explicit thread share is the only non-owner path in

- **WHEN** the owner shares thread T with U at level `comment`
- **THEN** `effectiveRole(U, T)` is `commenter` and U may read and comment, but
  not steer

### Requirement: Thread sharing has three explicit levels

A thread SHALL be shareable at exactly one of three levels, mapped onto the
lattice: `view`→`viewer` (read), `comment`→`commenter` (read + post comments),
`steer`→`contributor` (read + comment + send follow-ups / edit). Posting a comment
SHALL require the `comment` capability (commenter+); a plain `viewer` SHALL be able
to read the thread and its comments but not post.

#### Scenario: Viewer can read but not comment

- **WHEN** U holds a `view` (viewer) share on thread T
- **THEN** U reads T (200) but a `POST /threads/T/comments` is denied (403)

#### Scenario: Commenter can comment but not steer

- **WHEN** U holds a `comment` (commenter) share on thread T
- **THEN** U may `POST /threads/T/comments` (201) but `POST /threads/T/message`
  (follow-up) is denied

### Requirement: One authorizer gates capabilities by rank

The server SHALL expose `authorize(userId, resourceType, resourceId, capability)`
that resolves the role and grants the capability iff the role's rank meets the
capability's required rank. All thread/project route guards SHALL be expressed
through it. Authorization failure and a missing resource SHALL return the same
`404` (existence-hiding) for thread read routes.

#### Scenario: Capability requires its minimum rank

- **WHEN** U's role on T is `viewer`
- **AND** U requests a `manage` capability (min rank `admin`)
- **THEN** the request is denied

### Requirement: Runner crossing requires an explicit thread editor grant

A runner-bound action on another user's thread (follow-up, git read) SHALL remain
restricted to the thread owner and to holders of an explicit thread grant that can
steer (`contributor`/editor) via the audited, allow-listed delegation. The runtime
SHALL authorize such actions from a signed role claim, never a database lookup.

#### Scenario: A project admin cannot steer another owner's thread

- **WHEN** U is `admin` on project P but has no thread grant on T (owned by another)
- **THEN** a `POST /threads/T/message` from U does not resolve to the owner's
  runner and is rejected (U has no access to T at all)

#### Scenario: An editor sharee crosses via the allow-list

- **WHEN** U holds an explicit `steer` (contributor) grant on thread T
- **THEN** the allow-listed runner-bound routes resolve to the owner's runner,
  the runtime re-authorizes from the signed role claim, and the crossing emits the
  `share.steer_delegation` audit record

### Requirement: Assigning a user to a project takes a role and is validated

Adding a collaborator to a project SHALL create or update a single project grant
with a caller-chosen role from the lattice (`viewer | contributor | admin`; `owner`
is reserved for the creator/transfer). The server SHALL reject an unknown role.
Only a subject whose effective role on the project is at least `admin` SHALL add,
re-role, or remove members.

#### Scenario: Add with an explicit role

- **WHEN** a project admin adds user U with role `admin`
- **THEN** U's effective role on the project is `admin` and U can manage members

#### Scenario: Unknown role is rejected

- **WHEN** a request adds a member with role `superuser`
- **THEN** the server responds `400` and no grant is written

#### Scenario: Inherited members are visible but not editable as project grants

- **WHEN** the project belongs to org O and user V is an `admin` of O with no
  explicit project grant
- **THEN** the member list shows V as an inherited (`via org`) member
- **AND** a request to remove V's _project_ grant is a no-op (there is none to
  remove); V's access is changed only by changing their org role
