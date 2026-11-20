## Why

Git behavior is currently split across route handlers and service helpers, so related policies such as fetch throttling, in-flight dedupe, cache invalidation, credential use, and telemetry can drift. This is already visible in duplicate background fetches for the same repository and direct `fetchRemote` calls outside the common scheduler.

## What Changes

- Introduce a runtime-level Git coordination layer that owns cross-cutting Git execution policy for routes.
- Move background fetch scheduling, in-flight dedupe, status cache invalidation, and refs-updated notification behavior behind that layer.
- Route branch/status/fetch endpoints through the coordinator instead of calling low-level Git helpers directly.
- Preserve existing public HTTP API shapes and response contracts.
- Keep `@funny/core/git` as the low-level Git implementation, not the runtime orchestration layer.

## Capabilities

### New Capabilities

- `git-runtime-coordination`: Coordinates runtime Git operations per repository, including remote fetch dedupe, cache invalidation, and route-facing orchestration.

### Modified Capabilities

- None.

## Impact

- Affected runtime files: `packages/runtime/src/routes/git/*`, `packages/runtime/src/routes/projects/git-routes.ts`, and new/updated runtime service code.
- Affected tests: route tests covering project/thread fetch and branch/status endpoints, plus focused coordinator tests.
- No public API or database schema changes.
- No new third-party dependencies expected.
