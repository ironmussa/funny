# thread-access-control Specification

## Purpose

TBD - created by archiving change thread-access-middleware. Update Purpose after archive.

## Requirements

### Requirement: Thread routes resolve and authorize before handling

Every per-thread route MUST resolve the target thread and authorize the requesting
user before its handler runs. The authorization decision MUST be made by shared
middleware, not by per-handler inline policy checks, and the resolved thread MUST
be made available to the handler via the request context so the handler does not
re-fetch it. Fork and fork-and-rewind handlers MAY invoke a shared ownership-proof
checker against that loaded thread and authenticated actor to obtain the evidence
required by the operation. This additional check MUST NOT fetch the thread again
or weaken the middleware policy.

#### Scenario: Authorized request reaches the handler with the thread loaded

- **WHEN** an authorized user requests a thread route
- **THEN** the middleware has loaded the thread and placed it on the request context
- **AND** the handler runs without redundant thread fetching or implementing its own ownership policy
- **AND** a fork or fork-and-rewind handler can obtain ownership evidence through the shared checker using the loaded thread

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

### Requirement: Fork callers provide actor-specific ownership evidence

The typed server operation contract for fork and fork-and-rewind MUST require
ownership evidence bound to the exact actor and source thread consumed by the
operation. Calls with absent evidence, evidence for a different actor or source,
or a different permission kind MUST fail static verification. Evidence issuance
MUST check ownership against the authenticated actor and authoritative loaded
source; failure MUST prevent runner resolution and all fork side effects.

#### Scenario: Owner invokes either fork operation

- **WHEN** the authenticated owner requests fork or fork-and-rewind for an existing thread
- **THEN** ownership evidence permits the operation on that same actor and source
- **AND** existing response bodies, status codes, runner selection and registration behavior are preserved

#### Scenario: Caller omits or substitutes evidence

- **WHEN** a typed caller invokes either operation without ownership evidence or with evidence for a different actor, source or permission
- **THEN** static verification rejects the call

#### Scenario: Shared access does not grant ownership

- **WHEN** a non-owner with view or steer access requests either fork operation
- **THEN** the response is `404 Thread not found`
- **AND** no runner resolution, remote fork, registration or routing-cache write occurs for that request

#### Scenario: Ownership proof check denies the actor

- **WHEN** the ownership evidence checker finds that the loaded source belongs to another actor
- **THEN** it produces no ownership evidence
- **AND** the HTTP caller returns `404 Thread not found` without invoking the fork operation
