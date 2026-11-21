## Context

Chrome's tab memory includes the V8 heap, DOM/embedder memory, decoded images,
canvas backing stores, and GPU/WebGL allocations. The existing report only
provides total growth and tab-close recovery, so changing message retention or
Browser Panel behavior without correlated measurements would be speculative.

Funny already bounds several likely JavaScript sources: messages render through
a virtualizer, non-visible thread payloads are evicted, terminal scrollback is
limited, and terminal instances are disposed on unmount. The Browser Panel is a
high-frequency path that sends base64 JPEG frames through Socket.IO, retains the
latest frame per session, decodes it through a reused `Image`, and draws it into
a 1920x1080 canvas.

The diagnostic must remain opt-in, add negligible idle cost, avoid network
telemetry, and bound its own retained data during multi-hour runs.

## Goals / Non-Goals

**Goals:**

- Produce a timestamped time series that separates observable JavaScript heap
  growth from DOM/resource-count growth.
- Correlate samples with Browser Panel frame receipt and image decode activity.
- Keep a profiling run bounded and exportable for offline comparison.
- Make controlled multi-hour experiments repeatable without adding production
  behavior.

**Non-Goals:**

- Diagnose Chrome process RSS solely from page JavaScript; Chrome Task Manager
  or an external CDP/OS sampler remains necessary for native process memory.
- Automatically upload profiles or include user/message contents.
- Apply a speculative leak fix as part of the instrumentation change.
- Take heap snapshots periodically; snapshots are expensive and remain a
  deliberate DevTools action at experiment boundaries.

## Decisions

### Put the reusable profiler in Abbacchio

`@abbacchio/browser-transport` exports a configurable profiler and installer.
Funny dynamically imports the installer in development and configures the
global name as `window.__funnyMemory`. The API remains stopped until `start()`
is called and supports `sample`, `mark`, `status`, `getSamples`, `clear`,
`stop`, and `download`. The dynamic development import keeps the production
startup path unchanged.

The reusable package owns heap and generic DOM sampling, bounded retention,
defensive JSON copies, JSONL serialization, download behavior, global
replacement, and HMR cleanup. Applications may add named DOM selectors and a
serializable value collector. Funny owns only its Browser Panel counters and
passes their snapshot through that extension point.

Alternatives considered:

- A visible debug panel adds React state and rendering to the application being
  measured.
- Always-on telemetry changes production behavior and risks collecting more
  information than required.
- A standalone Playwright profiler cannot easily inspect Funny's module-private
  Browser Panel counters.

### Store bounded value-only samples

Each sample contains numbers, strings, and small copied records only. The
sampler uses a configurable ring buffer with a conservative default capacity;
it never retains DOM nodes, component references, frame strings, images, or
store objects. `getSamples()` returns copies.

### Instrument the frame lifecycle with cumulative counters

The Browser Panel path will count received frames, base64 payload characters,
decode starts, completions, failures, and superseded pending decodes. Counters
are cumulative, while per-session records are capped and removed when the
latest-frame cache is cleared. The memory sampler copies a small snapshot of
these counters.

This instrumentation records the suspected pressure without changing frame
frequency, image decoding, or rendering semantics.

### Use page-observable metrics and document the native-memory companion

Periodic samples use `performance.memory` when Chrome exposes it, plus DOM node
counts and Funny-specific counts such as canvases, xterm instances, Monaco
editors, and mounted virtual rows. The runbook pairs these values with Chrome
Task Manager's Memory footprint and JavaScript memory columns.

If post-GC JavaScript heap is stable while the process footprint grows, the
evidence points toward native canvas/image/GPU allocations. If heap and
application counters rise together, heap snapshots can identify retainers.

## Risks / Trade-offs

- **Sampling perturbs the application** → Default to 30-second intervals,
  perform only simple counts, and keep the profiler stopped by default.
- **`performance.memory` is Chrome-specific and approximate** → Represent
  unavailable values as `null` and pair runs with DevTools/Task Manager.
- **The profiler becomes a leak** → Enforce a bounded ring and copy only scalar
  data; cover retention behavior with tests.
- **Frame counters change a hot path** → Use constant-time numeric updates and
  no per-frame arrays, logging, React state, or allocations beyond existing
  event handling.
- **Development HMR installs duplicate timers** → Dispose the previous global
  profiler before replacement and stop it through the HMR dispose hook.
- **Reusable package becomes coupled to Funny** → Keep selectors and application
  values configurable; do not import Funny code from Abbacchio.
