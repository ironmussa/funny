## ADDED Requirements

### Requirement: Thread routes resolve and authorize before handling

Every per-thread route MUST resolve the target thread and authorize the requesting
user before its handler runs. The authorization decision MUST be made by shared
middleware, not by per-handler inline checks, and the resolved thread MUST be made
available to the handler via the request context so the handler does not re-fetch it.

#### Scenario: Authorized request reaches the handler with the thread loaded

- **WHEN** an authorized user requests a thread route
- **THEN** the middleware has loaded the thread and placed it on the request context
- **AND** the handler runs without performing its own ownership check or redundant thread fetch

#### Scenario: Missing thread is rejected before the handler

- **WHEN** a request targets a thread id that does not exist
- **THEN** the middleware returns `404 Thread not found` and the handler does not run

### Requirement: Read and owner-only access are distinct route classes

The middleware MUST expose two access classes. A read class authorizes users permitted
to view the thread (currently the owner only). An owner-only class authorizes the
thread owner exclusively and MUST be applied to every route that mutates the thread,
drives its agent, performs git operations, or administers access. A user who is not
the owner MUST be rejected by the owner-only class.

#### Scenario: Owner passes both classes

- **WHEN** the thread owner requests a read route and an owner-only route
- **THEN** both requests are authorized

#### Scenario: Mutation and git routes are owner-only

- **WHEN** any route that mutates the thread, sends agent input, or performs a git operation is requested by a non-owner
- **THEN** the request is rejected with `404 Thread not found`

### Requirement: Unauthorized and nonexistent threads are indistinguishable

An authorization failure on an existing thread MUST return the same response as a
request for a thread that does not exist (`404 Thread not found`), so route responses
do not reveal the existence of threads the requester may not access.

#### Scenario: Non-owner cannot distinguish a private thread from a missing one

- **WHEN** a user requests a thread route for a thread owned by someone else
- **THEN** the response is `404 Thread not found`, identical to the response for a nonexistent thread id
