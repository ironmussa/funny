## Why

Funny has a measured React DOM thread-viewer baseline but no equivalent GPUIX implementation, so
claims about native GPU rendering would currently be speculative. Before investing in a second
client renderer, the project needs a reproducible A/B benchmark that separates renderer gains from
virtualization, fixture, feature, machine, and warm-up differences.

## What Changes

- Add a minimal GPUIX thread-renderer benchmark that renders the same deterministic 500-message
  fixtures as the existing virtual and frozen React DOM viewers.
- Extend the profiling harness to run equivalent startup, scroll, thread-switch, streaming-update,
  idle, and repeated-navigation workloads against both renderer families.
- Produce a versioned JSON result schema containing timing distributions, missed-frame counts,
  process CPU and memory, renderer-specific counters, environment provenance, and run validity.
- Add a comparison report that distinguishes directly comparable metrics from browser-only and
  GPUIX-only diagnostics and evaluates explicit go/no-go thresholds.
- Add deterministic GPUIX renderer tests and document how to reproduce, interpret, and avoid
  overstating results.
- Keep product navigation, authentication, realtime transport, prompt submission, terminals, and
  general UI migration outside this benchmark change.

## Capabilities

### New Capabilities

- `client-renderer-benchmark`: Reproducible, provenance-aware performance comparison between the
  current React DOM thread viewer and a minimal GPUIX renderer using equivalent workloads.

### Modified Capabilities

None.

## Impact

- Adds a benchmark-only GPUIX package or entrypoint and its native npm dependencies.
- Extends `scripts/profile-client.ts`, the shared long-thread fixture, and performance result tooling.
- Adds native process sampling and GPUIX frame instrumentation alongside existing Chromium CDP
  measurements.
- Adds benchmark tests, result-schema validation, documentation, and CI-safe smoke coverage; full
  native performance runs remain machine-controlled rather than merge-blocking.
- Does not replace the existing client or make GPUIX a supported product renderer.
