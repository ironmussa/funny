# browser-trpc-api Specification

## Purpose

Defines the typed procedure API through which Funny clients call the operations the central server answers itself, so request inputs, responses and errors are checked end to end while authentication, authorization, runner isolation and existing REST consumers stay intact.

## Requirements

### Requirement: Typed procedures for server-answered operations

Every operation of a migrated route group SHALL be exposed as a named procedure with a declared input schema and a declared output type shared by server and client. A read operation SHALL be a query and a state-changing operation SHALL be a mutation. The client SHALL derive each call's input and result types from the same declaration the server serves, so a server change that alters an input or output shape fails the client typecheck.

#### Scenario: Output shape drift is caught at compile time

- **WHEN** a server procedure is changed to return a field type different from the one the client code reads
- **THEN** the repository typecheck fails before the change can be merged

#### Scenario: Invalid input is rejected with a validation error

- **WHEN** an authenticated client calls a procedure with input that does not match its schema
- **THEN** the server rejects the call with HTTP status 400 and a validation error, and the procedure's handler does not run

### Requirement: Client type surface isolated from server internals

The declaration that clients import to type procedure calls SHALL depend only on browser-safe shared modules. It SHALL NOT transitively load server implementation modules, database drivers, Bun-only modules or runtime-only modules into a client's typecheck or bundle. The repository SHALL automatically reject an import that breaks this isolation.

#### Scenario: Forbidden import is rejected

- **WHEN** a change makes the procedure declaration import a server, database, Bun-only or runtime-only module
- **THEN** the repository lint fails and names the offending import

#### Scenario: Client bundle contains no server code

- **WHEN** the web client is built after a group has migrated
- **THEN** the client bundle contains no server implementation modules

### Requirement: Authentication and request protections apply unchanged

Procedure calls SHALL pass through the same CORS, CSRF, rate-limit and session authentication as the REST API, and SHALL run as the authenticated user and active organization of the session. Every procedure that is not explicitly public SHALL refuse an unauthenticated call with HTTP status 401 before validating input or running its handler.

#### Scenario: Unauthenticated call is refused

- **WHEN** a request without a valid session calls a protected procedure
- **THEN** the server answers 401 and the procedure's handler does not run

#### Scenario: Cross-origin mutation is refused

- **WHEN** a mutation arrives from an origin that is not allowed
- **THEN** the server refuses it as it would refuse the equivalent REST request

### Requirement: Authorization semantics are preserved

A procedure that targets a resource SHALL authorize the caller with the same shared decision the equivalent REST route uses. When the resource does not exist or the caller may not access it, the response SHALL be the same 404 not-found answer, and it SHALL be returned before any input validation error for the rest of the payload. Scratch-thread restrictions and per-user scoping SHALL apply exactly as on REST.

#### Scenario: Another user's resource looks absent

- **WHEN** a user calls a procedure for a thread owned by another user with no share grant
- **THEN** the server answers 404 not found, identical to a call for a nonexistent thread

#### Scenario: Not-found wins over bad input

- **WHEN** a user calls a mutation for an inaccessible resource with otherwise invalid input
- **THEN** the server answers 404, not 400

### Requirement: Typed errors map to domain errors

Procedure failures SHALL carry a domain error category (not found, bad request, forbidden, validation, conflict, internal, …) and a message. The client SHALL surface each failure as the same domain error value its REST calls produce, with the same HTTP status, so callers and user-facing feedback need no transport-specific handling. Internal failures SHALL NOT expose stack traces or internal details to the client.

#### Scenario: Domain error round-trip

- **WHEN** a procedure fails with a not-found domain error
- **THEN** the client receives a not-found domain error with the server's message and HTTP status 404

#### Scenario: Unexpected server failure is sanitized

- **WHEN** a procedure throws an unexpected error
- **THEN** the client receives an internal domain error without a stack trace, and the server logs the details

### Requirement: Client calls reuse the shared transport policies

Procedure calls from a Funny client SHALL go through the same transport path as its REST calls: endpoint selection from the platform services, session credentials, telemetry spans and metrics, the circuit breaker, and request cancellation. Native and web clients SHALL be able to call procedures through their own platform transport without importing web-renderer modules.

#### Scenario: Circuit breaker covers procedure calls

- **WHEN** the circuit breaker is open because the server is unreachable
- **THEN** procedure calls fail fast exactly as REST calls do

#### Scenario: Cancelled call is aborted

- **WHEN** the caller aborts a pending procedure call
- **THEN** the HTTP request is aborted and the caller receives a cancellation result

### Requirement: Coexistence with REST during migration

A route group SHALL be migrated as one unit. While any first-party consumer (SDK, browser extension, plugin SDK, native client) still uses a migrated group's REST routes, those routes SHALL keep their current paths, request formats and responses, and SHALL produce the same results as the equivalent procedures. After a group migrates, the web client SHALL NOT add new untyped calls to it.

#### Scenario: REST and procedure agree

- **WHEN** the same user reads the same automation through its REST route and through its procedure
- **THEN** both return the same data

#### Scenario: New untyped call to a migrated group is rejected

- **WHEN** a change adds an untyped REST call from the web client to a migrated group
- **THEN** the repository lint fails

### Requirement: Runner-answered operations stay outside the procedure API

Operations answered by a user's runner SHALL NOT be exposed as procedures by this capability. They SHALL keep going through the runner proxy with its runner-isolation, steer-delegation and response-neutralization guarantees. Server ⇄ runner communication and realtime delivery SHALL be unaffected.

#### Scenario: Git operations keep their proxied route

- **WHEN** a client requests a thread's git diff after the procedure API is introduced
- **THEN** the request is served by the runner proxy route as before, with the same isolation checks
