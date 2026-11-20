## Context

See `proposal.md` for motivation. The client is pinned to GPUIX 0.5.1, whose production renderer exposes presentation inspection and screenshot APIs but no verified independent window-focus callback or production `flush()` boundary. Child `onFocus`/`onBlur` handlers therefore cannot safely represent window lifecycle, and capture readiness must be established through observable renderer state rather than an API available only on the test renderer.

The change crosses the native application root, platform lifecycle adapter, diff host element, capture script, diagnostics helper, error boundary, and CI workflow. It must preserve the React DOM fallback and the benchmark's intentional diagnostic collection.

## Goals / Non-Goals

**Goals:**

- Remove false lifecycle transitions without claiming unsupported GPUIX window events.
- Preserve bounded initial rendering while making complete diff content reachable.
- Replace fixed-delay-only capture with bounded, inspectable readiness.
- Keep standard UI free of performance overlays while retaining opt-in diagnostics.
- Make native failures readable even if the application theme provider failed.
- Enforce the existing native component contracts on supported CI hosts.

**Non-Goals:**

- Upgrading GPUIX or adopting APIs available only in 0.6.
- Adding external Markdown-link handling or changing the SVG icon pipeline.
- Replacing the manual production host or changing renderer benchmark definitions.
- Treating unavailable native telemetry or tests as passing evidence.

## Decisions

### Treat child focus as UI state, not application lifecycle

Remove lifecycle updates from the focusable application-root element and stop using its blur event as a window-inactivity signal. Under 0.5.1, the native lifecycle adapter will conservatively remain focused and visible while the window is alive, then transition both fields to false on the verified termination/stop boundary. Control-specific focus styling and keyboard behavior remain local to controls.

This is preferred to blur debouncing or checking a related target because those approaches still infer a host-window fact from child-element events and GPUIX does not document DOM-style focus propagation semantics. A future runtime with verified window activation callbacks can feed those callbacks into the existing lifecycle service without changing renderer-independent consumers.

### Expand native diffs through controlled line-limit state

Keep the current 120-line initial cap, track whether a message's diff has been expanded, and connect the native diff host's `onShowMore` callback to remove or raise the cap. The action should be exposed by the native diff itself so its truncation state and control remain consistent. Memoization equality must account only for durable message inputs; local expansion state remains inside the row.

Always rendering an unlimited diff was rejected because it removes the current protection against expensive message rows. A separate duplicate button was rejected because the native host already owns truncation semantics.

### Detect capture readiness from stable renderer evidence

After mounting and starting the production frame loop, poll a deterministic fixture marker through the renderer's automation or painted-text inspection. Require the expected marker and a stable consecutive observation before capture, with a bounded timeout and a short polling interval. The evidence JSON records timeout failure instead of publishing success. Unsupported-host behavior remains unchanged.

Using `TestGpuixRenderer.flush()` was rejected for this script because the artifact is intended to exercise the production renderer/window path and `GpuixRenderer` 0.5.1 does not expose `flush()`. A fixed sleep may remain only as a polling interval or final scheduling yield, never as the sole readiness criterion.

### Make diagnostic overlay policy explicit at each entry point

Change the diagnostics helper to accept whether the overlay is enabled, mapping disabled mode to `hidden` and enabled mode to the existing `full` mode. The standard client passes its existing diagnostics option; the product benchmark continues enabling diagnostics directly. Reset statistics only when collection is enabled.

Environment-wide implicit detection was rejected because tests, development commands, and benchmark launches need deterministic policy. The entry point already receives an explicit diagnostics value, so it remains the source of truth.

### Use a self-contained crash palette

The error boundary will style its outer surface, heading, detail text, and recovery instruction with a fixed high-contrast fallback palette. It must not depend on context below the boundary or on asynchronous preference state, since either may be implicated in the failure.

Moving theme resolution above the boundary was rejected because it widens the crash-prone surface and complicates a deliberately minimal recovery path.

### Add package-level UI gates to the existing GPUIX matrix

Add explicit `gpuix-ui` typecheck and test steps to the existing Ubuntu, macOS, and Windows matrix. Portable tests run everywhere; native tests execute where `TestGpuixRenderer` is available and must fail normally on those hosts. Existing test helpers may report unsupported native capability, but CI must not convert an available native failure into a skip.

A separate workflow was rejected because it duplicates checkout/install work and can drift from the product client's pinned runtime matrix.

## Risks / Trade-offs

- [The conservative 0.5.1 lifecycle state cannot report an OS-level temporary blur] → Document the limitation, avoid false resynchronization triggers, and add real window callbacks only after the runtime exposes a verified signal.
- [Diff expansion can create a heavy row] → Retain the bounded default and expand only after explicit user intent.
- [Painted or automation evidence can become stale if fixture labels change] → Centralize a semantic readiness marker with the fixture and test timeout/error output.
- [Polling can make capture slower] → Use a short interval and strict upper bound; stop immediately after stable readiness.
- [Disabling the overlay can accidentally disable benchmark statistics] → Keep benchmark enablement explicit and cover standard and benchmark policy separately.
- [Native tests may reveal platform-specific failures after becoming required] → Preserve explicit capability reporting and fix genuine supported-host failures rather than weakening the gate.

## Migration Plan

1. Add regression tests around lifecycle focus movement, diff expansion, diagnostic policy, capture readiness, and crash-surface styling.
2. Implement the compatible 0.5.1 runtime changes without altering dependency versions.
3. Add `gpuix-ui` checks to the existing matrix and validate native execution on macOS and Windows.
4. Roll back by reverting the isolated entry-point, component, script, and workflow changes; no data or server migration is required.
