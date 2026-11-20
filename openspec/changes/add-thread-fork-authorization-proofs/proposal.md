# Proposal

## Why

The fork routes enforce ownership, but the extracted fork use case accepts independently constructed actor and source values without evidence that they belong together. Requiring a typed ownership proof makes accidentally bypassing this precondition detectable when a new caller is added.

## What Changes

- Require an ownership proof bound to the exact actor and source consumed by both `fork` and `fork-and-rewind` use cases.
- Keep the owner middleware and its loaded thread; issue the proof through a shared, pure ownership helper inside a scoped callback, without another database read.
- Preserve HTTP responses, runner isolation, signed identity, raw request forwarding, and existing fork side effects.
- Add `@gdp-ts/core`, compatible Oxlint tooling, lint fixtures, compile-time negative tests, and ownership regression coverage.
- Clarify the existing thread-access requirement to permit scoped proof issuance after middleware authorization for these two operations.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `thread-access-control`: Require fork callers to supply ownership evidence tied to their actor and source; allow the shared proof helper to recheck the middleware-loaded thread without fetching it again.

## Impact

- `packages/server/src/modules/threads/`: proof module, command types, use case, public exports, and related tests.
- `packages/server/src/routes/threads.ts`: scoped naming and proof issuance for the two fork routes.
- Root lint configuration, dependency manifests and lockfile, compile-time test configuration, and OpenWiki documentation.
- Existing `modularize-thread-fork` work is the implementation baseline. Coordinate with its working-tree changes rather than overwriting them.
- No database migration, client contract change, runner protocol change, or expansion of sharing permissions.
