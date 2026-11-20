## Why

The GPUIX client now supports the primary thread workflow, but its presentation is still a functional scaffold: full-width message bands, a basic sidebar, an oversized header, and a separate composer make it visually and behaviorally inconsistent with the established React client. A renderer-neutral visual contract and a focused set of native presentational components are needed so the two clients communicate the same hierarchy, density, and interaction states while retaining renderer-specific implementations.

## What Changes

- Establish one canonical visual contract for the supported thread experience, including semantic color roles, typography, spacing, radii, control sizes, conversation width, and component states.
- Add composable GPUIX presentation components for the application shell, thread header, centered conversation viewport, user and assistant messages, prompt composer, sidebar sections and rows, and thread status metadata.
- Add reusable status and activity surfaces for tool calls, todos, permissions, loading, empty, error, and connectivity states.
- Align the React reference components and GPUIX components through shared semantic inputs and parity fixtures without importing DOM components into the native renderer or GPUIX components into the web renderer.
- Move renderer diagnostics and experimental controls out of the normal product hierarchy so they do not affect visual-parity evaluation.
- Add deterministic visual-contract and component-state tests, plus paired reference fixtures for supported viewport sizes and states.
- Preserve the current functional scope: this change does not recreate Dockview, TipTap, terminal, browser panels, settings, plugin visualizers, or other web-only surfaces in GPUIX.

## Capabilities

### New Capabilities

- `client-visual-parity`: Defines the shared visual semantics, component-state parity, responsive thread layout, and paired acceptance evidence for the React and GPUIX thread clients.

### Modified Capabilities

None.

## Impact

- `packages/gpuix-ui`: expanded tokens, icons, layout primitives, conversation components, navigation components, composer components, and status surfaces.
- `packages/client-gpuix`: replacement of the current presentation scaffold with the new GPUIX component composition while preserving its existing stores, commands, virtualization, and renderer boundaries.
- `packages/client`: small adaptations that expose the React reference states through the shared visual contract and fixtures; existing DOM-specific behavior remains in the web package.
- Tests and fixtures: shared semantic fixtures, renderer-specific component tests, responsive-state tests, and paired screenshot or structural evidence where the host can render it reliably.
- No backend route, realtime event, persistence, authorization, thread-state, or public server API changes.
