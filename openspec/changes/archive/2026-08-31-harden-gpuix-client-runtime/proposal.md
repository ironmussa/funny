## Why

The experimental GPUIX client already covers the primary thread workflow, but its runtime and verification surfaces still contain several gaps identified against the pinned GPUIX 0.5.1 contract: element focus can be mistaken for window lifecycle, long diffs cannot be expanded, visual captures rely on elapsed time, diagnostics are always enabled, and native component tests are not enforced on supported CI hosts. Closing these gaps now makes the client safer to evaluate without coupling the work to a GPUIX 0.6 migration.

## What Changes

- Separate native window focus/visibility lifecycle reporting from focus movement among GPUIX controls, with regression coverage for keyboard focus transitions.
- Let users expand a truncated native diff beyond its initial line limit while retaining the bounded initial render.
- Make GPUIX visual-parity capture wait for a renderer presentation boundary instead of relying only on a fixed delay.
- Gate the full GPUIX diagnostic overlay behind explicit development or diagnostic configuration.
- Give the native renderer error boundary explicit, theme-safe foreground and background styling.
- Run `gpuix-ui` tests and typechecking in the supported macOS and Windows GPUIX CI matrix, preserving explicit skips when a native test renderer is genuinely unavailable.
- Keep `@gpuix/react` and `@gpuix/native` pinned to 0.5.1; SVG tinting changes, external Markdown-link handling, and migration to GPUIX 0.6 are out of scope.

## Capabilities

### New Capabilities

- `gpuix-client-runtime-quality`: Defines resilient native presentation, bounded-but-expandable diffs, deterministic capture, configurable diagnostics, and supported-host verification for the GPUIX client.

### Modified Capabilities

- `client-platform-services`: Clarifies that host lifecycle state follows native window focus and visibility, not focus transitions between child controls.

## Impact

- Affects `packages/client-gpuix`, `packages/gpuix-ui`, GPUIX visual-parity scripts, and the macOS/Windows GPUIX CI job.
- Extends existing native lifecycle bridging and diff presentation behavior without changing renderer-independent APIs unless a narrowly scoped host-focus signal is required.
- Adds or updates native renderer tests and CI commands; no server API, persisted-data, or dependency-version changes are expected.
- Must remain compatible with the repository's pinned GPUIX 0.5.1 packages and the existing React DOM fallback.
