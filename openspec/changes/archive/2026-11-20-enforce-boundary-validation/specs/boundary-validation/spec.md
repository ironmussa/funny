## ADDED Requirements

### Requirement: Trust boundaries require runtime validation

The system SHALL validate untrusted structured data with a Zod schema before application logic uses the data as a typed value. Trust boundaries SHALL include HTTP bodies, typed HTTP query params, Socket.IO/WebSocket payloads, YAML/config/env/CLI input, persisted JSON from storage, and external API/provider responses when their structure is consumed.

#### Scenario: Boundary input is parsed before use

- **WHEN** a handler receives structured input from a trust boundary
- **THEN** the handler validates that input with Zod before passing it to application services or reading typed fields from it

#### Scenario: Internal narrowing is not treated as boundary validation debt

- **WHEN** code narrows an already trusted in-memory TypeScript value
- **THEN** the system does not require that internal narrowing to be replaced by a Zod schema

### Requirement: HTTP JSON request bodies are validated before use

Route handlers in `packages/server/src/routes` and `packages/runtime/src/routes` SHALL validate new Hono `c.req.json()` body reads with a Zod schema before using the body. Validation MAY be performed through a recognized parse helper, an existing `validate(schema, raw)` call, or direct `schema.safeParse(raw)` handling.

#### Scenario: New validated body read passes enforcement

- **WHEN** a route reads `c.req.json()` and validates the result near the read with a Zod schema
- **THEN** the boundary validation fitness check passes for that route

#### Scenario: New unvalidated body read fails enforcement

- **WHEN** a route adds a `c.req.json()` body read and uses or stores the result without nearby Zod validation
- **THEN** `bun run lint` fails with a boundary validation error identifying the file and source line

### Requirement: Existing HTTP body validation debt is baseline tracked

The system SHALL track existing unvalidated HTTP JSON body reads in a baseline file so the boundary validation check can run continuously without blocking on all pre-existing debt. The baseline SHALL distinguish duplicate unvalidated reads in the same file and SHALL be expected to shrink as route families are migrated.

#### Scenario: Existing baseline debt does not fail lint

- **WHEN** `bun run lint` runs with no new unvalidated HTTP JSON body reads beyond the baseline
- **THEN** lint exits successfully after reporting that no new boundary validation debt was added

#### Scenario: Baseline shrinks after migration

- **WHEN** a route family is migrated to Zod validation and its baseline entries are removed
- **THEN** the boundary validation baseline records fewer violations than before

### Requirement: Boundary parsing helpers are recognizable enforcement signals

The system SHALL provide or recognize small Zod-backed helper APIs for boundary parsing so validation is consistent and mechanically detectable. Accepted helper patterns SHALL return typed parsed values or domain-friendly validation errors.

#### Scenario: Helper based parsing is accepted

- **WHEN** a route parses a request body through a recognized helper such as `parseJsonBody(c, schema)`
- **THEN** the boundary validation fitness check treats that body read as validated

#### Scenario: Direct schema parsing is accepted

- **WHEN** a route reads raw boundary input and handles `schema.safeParse(raw)` or `validate(schema, raw)`
- **THEN** the boundary validation fitness check treats that body read as validated

### Requirement: Boundary enforcement expands by targeted phases

The system SHALL expand boundary validation enforcement one boundary family at a time. Each new family SHALL have a documented scope, accepted validation signal, baseline strategy when existing debt is present, and verification path before it is wired into required checks.

#### Scenario: Query param enforcement is introduced separately

- **WHEN** enforcement is added for typed HTTP query params
- **THEN** it is implemented as a targeted boundary check with its own scope and false-positive rules rather than by broadening the HTTP body check indiscriminately

#### Scenario: Socket payload enforcement is introduced separately

- **WHEN** enforcement is added for Socket.IO or WebSocket payloads
- **THEN** it uses socket-specific schemas or helpers and does not rely on route-body heuristics
