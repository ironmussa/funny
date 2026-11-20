## 1. Renderer-Independent Package Boundary

- [x] 1.1 Create the `@funny/client-core` workspace package with explicit exports, a DOM-free TypeScript configuration, and package-local test commands.
- [x] 1.2 Define segregated storage, navigation, transport, lifecycle, and semantic-effect interfaces plus the composed `ClientPlatform` type.
- [x] 1.3 Add platform validation that reports every missing required capability before any client controller or store is initialized.
- [x] 1.4 Implement deterministic in-memory platform services for core unit and contract tests, including storage subscriptions, lifecycle/location changes, captured effects, and diagnostics.
- [x] 1.5 Extend the repository layering fitness check to reject web/DOM/Tauri/Vite imports and browser globals/types from `packages/client-core/src`, with self-tests for allowed and forbidden cases.
- [x] 1.6 Register `@funny/client-core` in typecheck/test workflows and verify its production sources compile without DOM library types.

## 2. Web and Tauri Platform Adapter

- [x] 2.1 Add browser storage services that preserve existing keys, tolerate unavailable storage, publish changes, and report failures through client diagnostics.
- [x] 2.2 Add navigation and lifecycle services backed by browser history, route state, focus, and visibility subscriptions with complete cleanup behavior.
- [x] 2.3 Add explicit web/Tauri environment configuration and a transport adapter that preserves same-origin browser and localhost Tauri endpoint behavior.
- [x] 2.4 Add the semantic effect adapter for Sonner messages, system notifications, and application events, including diagnostic fallback for unsupported optional effects.
- [x] 2.5 Create the client composition root that validates and wires one platform instance before constructing APIs, stores, realtime controllers, or rendering React.
- [x] 2.6 Add web-adapter parity tests for existing storage values, browser/Tauri endpoint matrices, navigation/lifecycle subscriptions, effect delivery, and disposal.

## 3. Portable Storage and State Slices

- [x] 3.1 Inventory all production stores that directly or transitively depend on browser APIs and record each as portable, mixed, or intentionally renderer-specific.
- [x] 3.2 Move thread read-marker state into a platform-injected vanilla store factory while preserving its current web hook/export and persisted key.
- [x] 3.3 Move circuit-breaker state, probe, and cooldown scheduling into a platform-injected factory while keeping browser online/offline event wiring in the web adapter. (The prior store had no persisted circuit state, so compatibility requires keeping it ephemeral.)
- [x] 3.4 Split portable user preferences from CSS/document theme effects, instantiate the portable preferences store with platform storage, and preserve existing settings exports and keys.
- [x] 3.5 Remove route reads performed during project-store and thread-store module initialization by passing navigation snapshots/actions through their construction boundary.
- [x] 3.6 Add no-DOM core tests and web regression tests for defaults, round trips, corrupt values, storage denial, subscriptions, and legacy import compatibility for every migrated slice.

## 4. API and Endpoint Policy

- [x] 4.1 Move API and realtime endpoint resolution into pure core policy functions driven by explicit host mode, page origin, local server port, and allowlist configuration.
- [x] 4.2 Move remote-container URL validation into the core policy and add cases for malformed URLs, credentials, protocols, allowlists, and valid remote origins.
- [x] 4.3 Introduce an API client factory that receives transport, endpoint policy, clock/telemetry callbacks, circuit-breaker actions, and unauthorized handling instead of importing browser or store singletons.
- [x] 4.4 Rewire existing `lib/api` endpoint modules through the configured web API client while retaining their current callable exports.
- [x] 4.5 Add parity tests covering browser, Tauri, remote-thread, abort, network failure, circuit-breaker, unauthorized, and server-error behavior.

## 5. Realtime Event Processing

- [x] 5.1 Define narrow typed action ports for state changes currently performed by `ws-event-dispatch` without exposing complete Zustand store shapes.
- [x] 5.2 Define semantic effect payloads for terminal errors, environment activation, clone/worktree progress, agent completion/failure, hooks, pushes, and other current renderer effects.
- [x] 5.3 Extract event interpretation into a core dispatcher that accepts typed events, action ports, and an effect sink without importing Socket.IO, React, DOM APIs, web notification libraries, or web stores.
- [x] 5.4 Keep Socket.IO and remote WebSocket connection construction in the web adapter and forward decoded server events into the core dispatcher.
- [x] 5.5 Extract reconnect, route eligibility, focus/visibility throttling, and resynchronization decisions into a renderer-neutral realtime controller using lifecycle and navigation services.
- [x] 5.6 Rewire `use-ws` as a React lifecycle wrapper over the configured realtime controller, preserving StrictMode/HMR connection coalescing and cleanup.
- [x] 5.7 Add core tests proving equivalent state actions and semantic effects under the in-memory host, plus web regression tests for connection, reconnect, presence, PTY restore, focus/visibility resync, and remote sockets.

## 6. Boundary Audit and Documentation

- [x] 6.1 Audit `@funny/client-core` and migrated client modules for direct or transitive renderer dependencies and resolve every fitness-rule violation without broad allowlists.
- [x] 6.2 Document the `client-core`/web-adapter ownership boundary, composition flow, supported platform capabilities, and criteria for moving future logic in OpenWiki.
- [x] 6.3 Document intentionally web-only areas—DOM layout/observers, selection, drag-and-drop, shortcuts, CSS theme application, Monaco, terminal rendering, and browser panels—to prevent false portability expectations.
- [x] 6.4 Run focused core/client tests and the full repository test suite, then run `bun run lint` and `bun run typecheck` with no new failures.
