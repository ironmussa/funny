## Why

Real-time message fragments currently cause the native thread header, composer, and permission controls to reconcile alongside the transcript, while each fragment also re-parses rich Markdown. This expands native layout/draw work during the interaction most sensitive to frame latency and makes the diagnostic controls harder to interpret.

## What Changes

- Narrow native workspace and navigation subscriptions so streaming updates reconcile only the transcript and the changed message row.
- Render an assistant message as bounded plain text while its delivery is `streaming`, then restore the selected rich Markdown mode when the durable message arrives.
- Label the diagnostic rendering toggle by its current mode as `Rendering: Rich` or `Rendering: Fast`.
- Add a diagnostic `Reset stats` control connected to the active GPUIX renderer.
- Extend regression and benchmark evidence to verify component isolation and realistic streaming paint cost.

## Capabilities

### New Capabilities

- `gpuix-streaming-performance`: Defines lightweight native streaming presentation, isolated control rendering, and actionable frame-diagnostic controls.

### Modified Capabilities

None.

## Impact

- Affects the GPUIX thread view, transcript rows, native entry composition, diagnostics helpers, tests, and performance documentation.
- Does not change websocket payloads, renderer-independent workspace state, stored messages, or the web client.
