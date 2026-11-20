## MODIFIED Requirements

### Requirement: Read and owner-only access are distinct route classes

The middleware MUST expose two access classes. The read class authorizes users
permitted to view the thread: the thread owner **or any user holding an active share
grant for that thread**. The owner-only class authorizes the thread owner exclusively
and MUST be applied to every route that mutates the thread, drives its agent, performs
git operations, or administers access (including share create/list/revoke). A user who
is neither the owner nor a grant holder MUST be rejected by the read class; a non-owner
MUST be rejected by the owner-only class.

#### Scenario: Owner passes both classes

- **WHEN** the thread owner requests a read route and an owner-only route
- **THEN** both requests are authorized

#### Scenario: Sharee passes the read class but not the owner-only class

- **WHEN** a user with an active share grant requests a read route and then a mutation/git route
- **THEN** the read route is authorized and the mutation/git route returns `404 Thread not found`

#### Scenario: Mutation and git routes are owner-only

- **WHEN** any route that mutates the thread, sends agent input, or performs a git operation is requested by a non-owner
- **THEN** the request is rejected with `404 Thread not found`

## ADDED Requirements

### Requirement: Owner shares a thread with a specific organization member

A thread owner MUST be able to grant read access to a single thread to a specific
user who is a member of an organization the owner belongs to. The grant MUST be
identity-based: it records the invited user's id, and access is decided by the
requesting user's identity, not by possession of a link or token. The system MUST
reject a share whose target user is not a co-member of any of the owner's
organizations. Only the owner MUST be able to create shares on a thread.

#### Scenario: Owner shares with an org teammate

- **WHEN** the owner of a thread sends `POST /api/threads/:id/shares` with the user id of a teammate in their organization
- **THEN** a share grant is created for `(threadId, teammateUserId)` recording the owner as `sharedByUserId`
- **AND** the response succeeds

#### Scenario: Sharing with a non-org user is rejected

- **WHEN** the owner sends `POST /api/threads/:id/shares` with a user id that is not a member of any organization the owner belongs to
- **THEN** the request is rejected with `400` and no grant is created

#### Scenario: Non-owner cannot create a share

- **WHEN** a user who is not the thread owner (including an existing sharee) sends `POST /api/threads/:id/shares`
- **THEN** the request returns `404 Thread not found` and no grant is created

### Requirement: A shared link admits only the granted identity

Opening the thread link MUST grant access only to a user who owns the thread or has
an active share grant for it. Any other user — including a member of the same
organization who was not granted access — MUST receive the existing
`404 Thread not found` response. The link itself MUST NOT act as a bearer
capability: forwarding it to a non-granted user MUST NOT grant access.

#### Scenario: Granted user opens the link

- **WHEN** a user with an active share grant requests `GET /api/threads/:id`
- **THEN** the thread detail and transcript are returned

#### Scenario: Non-granted org member is denied

- **WHEN** a user without a grant (even a co-member of the owner's organization) requests `GET /api/threads/:id`
- **THEN** the response is `404 Thread not found`

### Requirement: Sharees may read and comment but not drive the thread

A user with a share grant MUST be able to read the thread detail, messages, events,
and comments, and MUST be able to create comments. A sharee MUST NOT be able to
perform any action that reaches the owner's runner or repository: starting/stopping
the agent, sending follow-up input, forking, rewinding, changing model/permission,
or any git operation MUST be owner-only and MUST return `404 Thread not found` for a
sharee. Comments created by a sharee MUST be stored as human annotations and MUST
NOT be injected into the agent's prompt.

#### Scenario: Sharee reads the transcript

- **WHEN** a sharee requests `GET /api/threads/:id/messages`
- **THEN** the messages are returned

#### Scenario: Sharee posts a comment

- **WHEN** a sharee sends `POST /api/threads/:id/comments`
- **THEN** the comment is stored with `source: 'user'` and is not added to the agent prompt

#### Scenario: Sharee cannot send a follow-up

- **WHEN** a sharee sends a follow-up message / start / stop / fork / rewind request for the thread
- **THEN** the request returns `404 Thread not found` and the owner's runner is not invoked

#### Scenario: Sharee cannot perform git operations

- **WHEN** a sharee requests any `/api/git/:id/*` route for the shared thread
- **THEN** the request is denied (owner-only) and no git command runs

### Requirement: Live agent stream is delivered to sharees via a per-thread room

While a sharee has the thread open, the system MUST deliver the live in-thread agent
stream (assistant messages and tool calls) to that sharee in real time. Delivery
MUST be gated: a socket MUST be admitted to the thread's live channel only after the
server verifies the connecting user can view the thread. A user who cannot view the
thread MUST NOT receive any of its live events.

#### Scenario: Sharee receives live events after joining

- **WHEN** a sharee opens a thread they have access to and the agent emits an assistant message or tool call
- **THEN** the sharee receives that event in real time

#### Scenario: Join is gated by view access

- **WHEN** a user without view access attempts to join the thread's live channel
- **THEN** the join is refused and the user receives no thread events

### Requirement: Presence shows who is viewing the shared thread

When a user opens a thread's live channel, the system MUST notify other viewers of
that thread that the user is present, including enough identity to render an avatar
(user id, name, image). When the user disconnects or leaves the thread, the system
MUST notify other viewers that the user is gone. Presence MUST be scoped to the
individual thread and MUST NOT leak to users who cannot view it.

#### Scenario: Avatar appears on join

- **WHEN** a viewer opens a shared thread that another viewer already has open
- **THEN** each viewer sees the other's avatar in the thread's presence indicator

#### Scenario: Avatar disappears on leave

- **WHEN** a viewer navigates away or disconnects
- **THEN** the remaining viewers stop seeing that viewer's avatar

### Requirement: Revoking a share immediately removes access

The owner MUST be able to revoke a share. After revocation the formerly-shared user
MUST lose read access (subsequent reads return `404 Thread not found`), MUST be
removed from the thread's live channel, and MUST stop receiving live events and
presence for that thread.

#### Scenario: Revoked user loses read access

- **WHEN** the owner sends `DELETE /api/threads/:id/shares/:userId` and the revoked user then requests `GET /api/threads/:id`
- **THEN** the response is `404 Thread not found`

#### Scenario: Revoked user is evicted from the live channel

- **WHEN** the owner revokes a share while the revoked user has the thread open
- **THEN** the revoked user is removed from the thread's live channel and receives no further live events for it
