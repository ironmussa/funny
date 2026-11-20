## Why

Reusable client state and transport logic currently imports browser globals and web-only effects directly, which prevents the same behavior from running under a non-DOM renderer such as GPUIX without duplicating it. Establishing an explicit platform boundary now lets Funny preserve the existing web/Tauri experience while making renderer-independent client logic testable and reusable.

## What Changes

- Introduce typed client platform services for key-value storage, route/location state, API and WebSocket endpoint resolution, application focus/visibility, and user-facing effects such as notifications and browser events.
- Provide a web/Tauri implementation that preserves the current browser behavior and storage keys.
- Move shared API, WebSocket event handling, selectors, state mutations, and eligible Zustand store logic behind those services instead of reading browser globals directly.
- Keep DOM layout, observers, selection, drag-and-drop, browser shortcuts, CSS theme application, and renderer-specific components in the web layer.
- Add boundary tests and dependency checks that prevent renderer-independent modules from reintroducing direct DOM or browser-global access.
- Define the platform contract so a future GPUIX client can provide its own implementation; this change does not add GPUIX or build a native renderer.

## Capabilities

### New Capabilities

- `client-platform-services`: Defines how renderer-independent client logic obtains persistence, navigation, transport configuration, lifecycle state, and UI effects through an injected platform contract while preserving existing web/Tauri behavior.

### Modified Capabilities

None.

## Impact

- **Client architecture:** `packages/client/src/stores`, `packages/client/src/lib/api`, WebSocket hooks/dispatchers, application bootstrap, and associated tests.
- **Shared behavior:** eligible state mutations, selectors, and transport event handling become usable without a DOM; renderer-specific React hooks and components remain in `packages/client`.
- **Compatibility:** existing local-storage keys, API/WebSocket URL semantics, focus/visibility handling, notifications, and web/Tauri runtime behavior remain compatible.
- **Dependencies:** no GPUIX dependency is introduced. A small internal package or client-local module boundary may be added, depending on implementation findings.
