## Why

Runtime validation is inconsistent at trust boundaries: some HTTP, socket, config, persisted JSON, and external-response inputs are validated with Zod, while others rely on ad hoc casts or manual checks. This makes validation coverage hard to reason about and allows new unvalidated inputs to enter the system without a clear review signal.

## What Changes

- Introduce an explicit boundary-validation policy for untrusted data entering the application.
- Standardize Zod-backed parsing helpers for boundary inputs so validation is easy to recognize in code review and tooling.
- Enforce new unvalidated HTTP JSON body reads through a baseline-backed fitness check.
- Use the current HTTP body backlog as migration debt that shrinks over time rather than blocking all work immediately.
- Extend enforcement in phases to query params, Socket.IO payloads, persisted JSON, config/YAML, and external API responses.
- Keep existing `eslint-plugin-zod` rules as schema hygiene, not boundary coverage.

## Capabilities

### New Capabilities

- `boundary-validation`: Defines where runtime validation is required, how boundary inputs are parsed, and how new unvalidated boundary reads are prevented.

### Modified Capabilities

- None.

## Impact

- Root lint script and fitness checks.
- Server and runtime route handlers under `packages/server/src/routes` and `packages/runtime/src/routes`.
- Validation helpers and Zod schemas in runtime/server/shared packages.
- Future migrations for Socket.IO handlers, query parsing, persisted JSON reads, YAML/config parsing, and structurally used external API responses.
