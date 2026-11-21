## Why

Long-running Funny browser tabs have been observed growing from roughly 2 GB to
6 GB over several hours, with the memory released only when the tab closes.
Funny needs a low-overhead, repeatable way to distinguish retained JavaScript
objects from DOM growth and Chrome-native canvas, image, or WebGL memory before
changing runtime behavior.

## What Changes

- Add a reusable opt-in browser memory sampler to
  `@abbacchio/browser-transport`, then configure it from Funny development
  builds with Funny-specific DOM/resource counters.
- Track Browser Panel frame ingestion and decode activity so memory growth can
  be correlated with frame rate, payload size, sessions, and overlapping image
  decodes.
- Expose a small development console API to start, stop, inspect, clear, and
  download a profiling run as JSONL.
- Publish each sample to Abbacchio as run-tagged gauge metrics so a profiling run
  is stored and can be queried after the tab is gone, and install the profiler
  wherever OTLP is configured so production tabs can be investigated too.
- Document a controlled idle/thread/browser-panel/terminal experiment and how to
  interpret heap growth versus process-memory growth.
- Add focused tests for sampling lifecycle, bounded retention, serialization,
  and Browser Panel diagnostics.

## Capabilities

### New Capabilities

- `client-memory-diagnostics`: Opt-in browser memory sampling, Funny resource
  counters, Browser Panel frame diagnostics, and exportable profiling sessions.

### Modified Capabilities

None.

## Impact

- Affects Abbacchio's browser transport package, Funny's client bootstrap, and
  Browser Panel frame rendering.
- Adds no production UI, server API, or runtime dependency. Stored samples are
  counts and byte totals in Abbacchio's existing metrics table; no new Funny
  table, route, or user data is introduced.
- Adds client tests and developer documentation for multi-hour memory
  investigations.
