## Why

The renderer benchmark shows that a GPUIX client can substantially reduce process CPU and resident memory, but the benchmark is not a usable Funny client and cannot establish interaction parity because GPUIX 0.4.0 lacks public presentation timing. We should turn the proven renderer primitives and existing `@funny/client-core` boundary into a production-capable native thread workflow while retaining the React DOM client as the default fallback.

## What Changes

- Add a private production `@funny/client-gpuix` package with its own native entry point, release build, and explicit experimental launch selection.
- Implement a GPUIX `ClientPlatform` composition for persistence, in-memory navigation, authenticated HTTP transport, window lifecycle, semantic effects, and diagnostics.
- Deliver a vertical thread-client slice covering authentication bootstrap, project and thread navigation, virtualized message history, Markdown/code/tool-call/diff content, prompt submission, response streaming, stop/resume controls, and permission approval.
- Reuse renderer-neutral types, API policies, realtime processing, state machines, and portable stores rather than importing React DOM components or browser globals.
- Keep React DOM/Tauri behavior and persisted data compatible; the web renderer remains the default throughout the MVP.
- Add contract, state, native-renderer, and end-to-end smoke coverage plus paired benchmark acceptance checks that remain evidence-bounded when GPUIX presentation metrics are unavailable.
- Explicitly defer terminal emulation, embedded browser/annotator, Dockview layouts, Monaco, plugin visualizers, workflows, analytics, test runner, advanced settings, and complete mobile parity.

## Capabilities

### New Capabilities

- `gpuix-thread-client`: Defines the native GPUIX application lifecycle and the minimum authenticated project/thread workflow required for an experimental usable client.

### Modified Capabilities

- `client-platform-services`: Extends the platform contract with a native GPUIX host implementation while preserving browser and Tauri behavior.

## Impact

- Adds `packages/client-gpuix` and GPUIX-specific build and launch wiring.
- Extends `packages/client-core` only where native composition needs renderer-neutral contracts or stores.
- Reuses server REST and Socket.IO contracts without introducing a second backend protocol.
- Requires pinned `@gpuix/react` and `@gpuix/native` dependencies and supported native binaries.
- Adds an experimental renderer selection path; no existing command, route, storage key, or default renderer is removed.
- Uses `@funny/client-benchmark` for parity and performance acceptance without shipping benchmark orchestration in the product client.
