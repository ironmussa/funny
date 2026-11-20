## Context

`@funny/client-core` already defines DOM-free platform services, endpoint policy, API transport, realtime dispatch, and a small set of portable stores. The React DOM client composes those services through a web adapter, but most product stores and all UI components still live in `@funny/client`. The completed GPUIX benchmark proves that the pinned native renderer can display a virtualized 500-message fixture with Markdown, code, tool calls, tables, and diffs, and shows materially lower local process-tree CPU and RSS. It does not expose public presented-frame timing or painted-row bounds, and its repeated-navigation memory growth exceeded the current 5 percent acceptance target in the single controlled run.

The native client must use the existing REST, Socket.IO, authorization, thread state-machine, and permission contracts. It cannot import React DOM UI, browser globals, Radix, Dockview, Monaco, xterm, or web-only hooks. See the two delta specs for observable behavior.

## Goals / Non-Goals

**Goals:**

- Produce a separately launchable native client that is useful for the primary authenticated agent-thread workflow.
- Keep one canonical domain transition path across renderers and isolate host differences behind `ClientPlatform` and small renderer ports.
- Preserve durable identifiers, event ordering, remote-origin policy, access-control behavior, and compatible renderer-neutral preferences.
- Make fallback and rollback immediate by retaining the web renderer and selecting GPUIX explicitly.
- Continuously compare functional parity and resource behavior without converting unavailable presentation telemetry into invented latency.

**Non-Goals:**

- Sharing React DOM components or emulating DOM APIs inside GPUIX.
- Replacing the default renderer in this change.
- Shipping terminal emulation, embedded web content, annotator, plugin visualizers, Dockview layouts, Monaco editing, workflows, analytics, test runner, or the complete settings surface.
- Changing backend routes, Socket.IO event contracts, thread authorization, or permission semantics solely for the native renderer.
- Treating a single-machine benchmark as a universal performance guarantee.

## Decisions

### 1. Create a product package separate from the benchmark renderer

Add `packages/client-gpuix` as the production package. It depends on `@funny/client-core`, `@funny/shared`, React, and pinned GPUIX packages. It may use `@funny/client-benchmark` only as a development/test dependency for parity fixtures and acceptance adapters. `client-gpuix-benchmark` remains a minimal measurement target and does not become the application shell.

This prevents authentication, networking, production stores, and optional product features from contaminating the controlled benchmark. Turning the benchmark package directly into the product was rejected because every product addition would change the benchmark workload and invalidate historical interpretation.

### 2. Use an independent GPUIX composition root

The native entry point constructs and validates a `ClientPlatform` before rendering. The platform contains:

- a native key/value store rooted in the per-user application-data directory;
- in-memory navigation with stable Funny path parsing;
- a Bun/native HTTP transport with request cancellation, cookie/session handling, endpoint policy, and remote-origin validation;
- GPUIX window focus and visibility signals;
- native toast/application-event presentation with structured fallbacks;
- redacting diagnostics.

The platform host mode becomes an explicit native variant rather than pretending to be `browser` or `tauri`. Browser and Tauri composition remain unchanged.

A compatibility layer that defines fake `window`, `document`, or `localStorage` objects was rejected because it would hide renderer coupling and allow web-only dependencies to leak into the native package.

### 3. Persist session material through a bounded native session store

The native HTTP adapter owns a cookie/session jar and persists only reusable session material after successful authentication. Submitted username/password values remain view state until the request completes and are never written. Persistence uses atomic replacement and user-only permissions where the host supports them; unsupported permission guarantees prevent persistent-session opt-in and are reported diagnostically.

An OS-keychain-only requirement was rejected for the MVP because it adds a separate platform integration and release matrix before the thread workflow can be tested. The session-store interface remains narrow so an OS keychain can replace the file implementation without changing auth or UI state.

### 4. Extract vertical state slices, not all web Zustand stores

Only the state required by the native vertical slice moves behind renderer-neutral factories or vanilla stores:

- auth/session bootstrap;
- accessible project and thread navigation;
- selected thread, pagination, messages, tool calls, run and permission state;
- prompt submission and lifecycle actions;
- realtime connection and resynchronization status.

The existing web hooks become adapters/selectors over these slices only where doing so preserves current behavior. Renderer-specific layout, DOM measurement, terminal, browser panel, shortcuts, dialogs, and CSS preference state stay in `@funny/client`.

Copying the web stores into the GPUIX package was rejected because fixes to optimistic updates, permissions, or event ordering would immediately diverge. Migrating all stores first was also rejected because it would delay the first usable slice and expand risk far beyond the MVP.

### 5. Share realtime interpretation but own the native connection lifecycle

The GPUIX package establishes the existing Socket.IO connection using the native session and resolved server origin, normalizes incoming messages, and passes them through shared realtime dispatch and portable state actions. Connection, reconnect, focus resync, stale-event suppression, and cleanup are explicit services with deterministic tests.

The native renderer does not import `use-ws` or browser event dispatch. Web-only toast, focus, `CustomEvent`, and route effects remain in the web adapter.

### 6. Build one bounded native application shell

The MVP shell has four states: bootstrap/login, navigation plus thread, recoverable error, and unsupported-host. The authenticated layout uses a project/thread sidebar, thread header, one native `virtual-list`, a composer, run controls, and an in-flow permission card/dialog. Message rows have stable keys and renderer-native Markdown, code, diff, text, and fallback blocks.

Pagination anchors are based on canonical message identifiers and scroll intent, not pixel values shared with the web client. Streaming updates modify the stable assistant row rather than replacing the list. Permission controls use request identifiers and become inert immediately after one response.

A wholesale recreation of the current Dockview shell was rejected because most MVP complexity would be spent on panels that are explicitly deferred.

### 7. Separate mutation acknowledgement from presentation claims

Native actions record server acknowledgement and state-mutation completion. They are not labeled input-to-present or frame latency unless a pinned GPUIX public API later supplies a verified presentation boundary. The shared renderer benchmark remains the release comparison tool and records structured unsupported capabilities.

The renderer remains experimental until functional parity passes and repeated-navigation retained growth is at most 5 percent on the supported release-host matrix. Presentation-dependent promotion gates remain inconclusive rather than blocking unrelated functional development, but GPUIX cannot become the default until those gates have real evidence or a separately approved policy change.

### 8. Gate dependencies and renderer boundaries automatically

Layering validation forbids DOM/browser/Tauri/React DOM imports from `client-gpuix` domain, platform-neutral slices, and `client-core`. GPUIX imports are allowed only in the native renderer and host-adapter boundary. CI always runs shared contract and state tests; it builds GPUIX on compatible package hosts and runs native smoke tests only where the published binary and display/runtime prerequisites are available.

## Risks / Trade-offs

- **[GPUIX public telemetry is incomplete]** → Preserve explicit unsupported capabilities, retain the web default, and re-audit each pinned GPUIX upgrade before changing presentation gates.
- **[Native memory growth remains above target]** → Add repeated-navigation profiling to milestone acceptance, investigate retained rows/subscriptions/session objects, and prevent default rollout while the threshold fails.
- **[State extraction regresses the web client]** → Move one vertical slice at a time behind compatibility adapters and require existing client tests plus focused parity tests before continuing.
- **[Socket.IO or Better Auth assumes browser behavior]** → Spike cookie/session and WebSocket behavior first, test against a real local server, and stop before UI expansion if transport semantics cannot be preserved.
- **[Native persistent sessions are weaker than an OS keychain]** → Never persist passwords, restrict and redact the session store, support non-persistent sessions, and keep an interchangeable session-store port.
- **[Feature fallback hides important agent output]** → Require a visible typed fallback with textual payload and include fixture inventory/checksum parity in acceptance.
- **[Two renderers increase maintenance cost]** → Share only domain behavior and contracts, keep renderer components intentionally separate, and define a narrow MVP rather than parallel full-feature development.
- **[Native release support differs by OS/architecture]** → Probe and record support per pinned dependency, fail explicitly on unsupported hosts, and enable release targets only after native smoke coverage passes there.

## Migration Plan

1. Land and archive the completed renderer benchmark so its fixture and comparison contracts are stable.
2. Add the production package, host probe, release build, experimental launch command, and unsupported-host result before connecting product state.
3. Implement and contract-test native platform services, authentication, cookie/session persistence, and realtime connection against a local server.
4. Extract the minimal portable auth/navigation/thread slices while preserving web adapters and tests.
5. Build the read-only project/sidebar/thread shell and validate long-history feature parity.
6. Add prompt, streaming, stop/resume, permission response, reconnect, and error recovery.
7. Run supported-host smoke, end-to-end workflow tests, accessibility/keyboard review, and controlled paired profiling.
8. Keep selection experimental. If a milestone regresses, disable or remove the GPUIX launch entry without migrating or deleting user/server data; the React DOM client remains immediately usable.

## Open Questions

- Which GPUIX release first exposes a trustworthy presented-frame boundary and painted virtual-list counters?
- Which native notification surfaces are sufficiently stable to enable by default rather than recording an unsupported-effect diagnostic?
- Should a later hardening change replace the bounded session file with platform keychains before broader distribution?
