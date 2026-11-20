## Context

`ThreadView`, `ThreadControls`, and `PermissionCard` currently subscribe to complete Zustand-compatible stores. A streaming delta replaces the selected thread workspace object, so all three reconcile even though run, permission, navigation, and local composer state are unchanged. `MessageRow` receives the updated message and always follows the global rich-content choice, causing Markdown parsing during each fragment.

The GPUIX renderer already supports resetting debug-frame overlay statistics, but the renderer instance is owned by the native entry and is not available to the product component tree. See the proposal and `gpuix-streaming-performance` specification for observable behavior.

## Goals / Non-Goals

**Goals:**

- Keep store subscriptions at the narrowest stable value required by each component.
- Give streaming rows a cheap render path derived from existing delivery state.
- Preserve rich rendering after durable reconciliation without separate duplicated message state.
- Expose renderer reset as an explicit diagnostic-only capability.
- Prove isolation through render-count regression tests and full-shell benchmark evidence.

**Non-Goals:**

- Throttling, buffering, or changing realtime events.
- Replacing native Markdown or changing the 400-character message preview bound.
- Changing the web client or renderer-independent store shape.
- Adding a persistent rendering-mode preference.

## Decisions

### Split selected-thread composition into independently subscribed leaves

The outer thread view will subscribe only to `selectedThreadId`. A selected-thread composition component will own the Rich/Fast toggle, while separate memoized header, content, controls, and permission components subscribe through selectors to only their required store values. Streaming still changes the content component because its workspace data changes, but stable siblings receive unchanged props and do not reconcile.

Alternative considered: retain broad subscriptions and wrap only JSX sections in `useMemo`. This still executes the parent render and couples correctness to dependency lists; selector isolation expresses the actual data boundary and follows the repository's existing `useStoreValue` pattern.

### Use message delivery as the sole streaming render signal

An assistant row will enable rich content only when the global mode is Rich and `message.delivery !== "streaming"`. The store already transitions streaming messages to durable confirmed messages, so no timer, run-status inference, or duplicated local state is needed. User messages and Fast mode retain their current behavior.

### Inject an optional diagnostic reset callback from the renderer owner

The native entry will wrap the renderer's reset method and pass it through the app/shell/header boundary only in diagnostic mode. Product components remain renderer-agnostic and tests can provide a spy. The frame-diagnostics helper will own the reset call so initial configuration and interactive reset share one implementation.

### Measure stable component renders directly

Components involved in the isolation contract will accept no benchmark-only flags. Native tests will wrap exported memoized boundaries in React Profiler where the host renderer is available, while portable equality/selector tests will establish reference stability on Linux. The full product smoke remains the end-to-end paint check.

## Risks / Trade-offs

- [Selector functions returning new objects would defeat isolation] → Select primitives or existing store object references and test reference stability across streaming updates.
- [Plain streaming text briefly differs from final Markdown layout] → Preserve the bounded content exactly and switch only when the delivery state becomes durable.
- [A reset callback could leak renderer ownership into UI modules] → Pass a single optional action rather than the renderer object, and render it only in diagnostic mode.
- [Component splitting increases app module surface] → Keep boundaries local and name them by product responsibility; avoid new global abstractions.

## Migration Plan

Ship as an internal native-client rendering change with no data migration. Rollback restores broad subscriptions and always-rich streaming rows; diagnostic reset remains optional and does not affect normal startup.
