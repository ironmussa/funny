## Why

Funny's built-in Claude and Codex providers lag behind their current agent SDK releases, leaving compatibility fixes and newly supported reasoning behavior unavailable. Updating them together with focused regression coverage keeps provider execution current without expanding the public product surface.

## What Changes

- Update the Claude Agent SDK dependency to the current reviewed `0.3.251` release.
- Update the Codex SDK dependency to the current reviewed `0.151.0` release across all packages that declare it.
- Forward Funny's `max` reasoning effort to Codex as native `max` instead of downgrading it to `xhigh`.
- Add regression coverage for Codex effort normalization and preserve the existing Claude/Codex event-adapter behavior.

## Capabilities

### New Capabilities

- `agent-sdk-compatibility`: Defines compatibility and reasoning-effort forwarding requirements for the built-in Claude and Codex SDK adapters.

### Modified Capabilities

None.

## Impact

- Dependencies and lockfile entries for `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`.
- The Codex adapter in `packages/core/src/agents/codex-sdk.ts`.
- Provider regression tests in `packages/core` and any affected package-level type resolution.
- No intended breaking API or persisted-data changes.
