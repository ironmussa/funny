# Proposal

## Why

Thread creation currently mixes scratch/project rules, runner selection, identity forwarding, remote execution, persistence, and HTTP responses in `server/src/routes/threads.ts`. Extracting this bounded flow provides a practical pilot for feature-oriented organization, ports and adapters, and stronger domain types while making orchestration independently testable.

## What Changes

- Introduce a server-owned `modules/threads` module for normal and idle thread creation, with a small public application API.
- Extract a transport-independent creation use case and pure scratch/project normalization from `createThreadOnRunner`.
- Represent normalized creation targets with an immutable discriminated union; use local branded identifiers at trusted boundaries without changing shared wire types.
- Adapt existing runner resolution, signed identity forwarding, request ports, registry persistence, and routing cache to narrow application ports.
- Preserve HTTP paths, payload extensions, response shapes, errors, runner isolation, and operation ordering through characterization and regression tests.
- Add an automated dependency check and document how to extend this pilot.

## Capabilities

### New Capabilities

None. This is an internal refactor with no new externally observable behavior.

### Modified Capabilities

None. Existing access and transport contracts remain in force. `.openspec.yaml` sets `skip_specs: true`; tests characterize existing behavior rather than introducing artificial capability requirements.

## Impact

- Primary code: `packages/server/src/routes/threads.ts`, new `packages/server/src/modules/threads/`, server tests, architecture fitness checks, and OpenWiki.
- Existing `runner-ports`, `runner-resolver`, and `thread-registry` remain implementation dependencies behind adapters. No database migration, protocol change, new package, or deployment topology change.
- Coordinate with `codebase-simplification`, especially its repository wiring and thread-creation helper work. Reuse completed helpers; do not duplicate or expand that change's runtime work.
- This pilot evaluates hexagonal boundaries, feature-oriented structure, and selective value modeling. Full CQRS, event sourcing, a global identifier migration, and repository-wide folder reorganization are deferred.
