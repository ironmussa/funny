## Why

The gRPC-only migration is functionally complete, but it exposed transport details across browser handlers, runner presence, request proxying, runtime persistence APIs, connection lifecycle, and five stream classes. Establishing narrow application ports now will make future protocol and reliability changes local to adapters, while characterization and contract tests protect the behavior already proven by the migration.

## What Changes

- Add a production-shaped vertical characterization test that connects the real TypeScript runtime gRPC client to the real server endpoint before structural refactoring begins.
- Introduce capability-oriented ports for runner requests, presence, terminal dispatch, tunnel dispatch, and browser event publication; keep gRPC as the sole production adapter.
- Use Branch by Abstraction to migrate consumers incrementally without changing public HTTP, browser Socket.IO, protobuf, persistence, authorization, or retry behavior.
- Split the runtime team client into enrollment, connection supervision, remote data, event publication, control dispatch, tunnel, and terminal responsibilities behind a compatibility facade.
- Split browser Socket.IO delivery from runner presence and replace global transport service location with composition-root injection.
- Add adapter contract tests, ambiguous-commit/restart coverage, tenant-isolation vertical tests, a static no-legacy fitness check, and a longer scheduled soak/chaos profile.
- Rename transport-neutral modules whose current WebSocket names obscure that their runner implementation is gRPC.

## Capabilities

### New Capabilities

None. This is an internal refactor and verification change that preserves the existing runner transport contract.

### Modified Capabilities

None. The externally observable requirements remain those of `runner-grpc-transport`.

## Impact

- Runtime: `team-client`, `grpc-team-transport`, connection lifecycle, remote persistence facade, tunnel/terminal/control handlers, and their tests.
- Server: runner proxy, presence registry, browser Socket.IO handlers, gRPC dispatchers, composition root, and lifecycle tests.
- Verification: in-process vertical harness, adapter contracts, restart/fault injection, architecture fitness checks, and scheduled soak execution.
- No public API, protobuf, database schema, environment variable, or browser protocol change is intended.
