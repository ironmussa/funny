# GPUIX measurement readiness

The benchmark pins `@gpuix/react` and `@gpuix/native` to `0.5.1`, corresponding to upstream commit
`301b834df4d0f28e8cfa2fde5e5693adeb909a7a` and tags `@gpuix/react@0.5.1` and
`@gpuix/native@0.5.1`.

## Published host support

The native package publishes optional binaries for macOS arm64/x64, Linux arm64/x64 with glibc,
and Windows arm64/x64. `@gpuix/react` declares React 18 or 19 as a peer. No Node engine constraint
is declared by either GPUIX package. Funny's benchmark continues to use the repository's Bun and
Node engine requirements and treats a missing native binary as structured unsupported capability.

## Presentation and frame timing

The 0.5.1 native declaration exposes overlay mode controls and aggregate draw statistics through
`getDebugFrameOverlayStats()`: current, p90, p99, max, frame count, and sample count. It does not
expose the underlying raw samples. The automation protocol declares a `{ event: "frame" }` server
event, but inspection of the tagged implementation finds no code path that emits it.
`startFrameLoop()` schedules event-loop ticks and cannot confirm that a particular state was
presented.

Consequently, raw frame timing and presentation acknowledgement are unsupported for verdict-bearing
comparisons at this pinned version. Aggregate overlay values remain useful draw-cost diagnostics,
but the benchmark must not substitute them, tick duration, mutation commit completion, or application
timers for presented-frame metrics.

## Other capabilities

- Screenshot capture is public, with actual availability determined at runtime by the native build.
- Per-process GPU memory is not exposed by GPUIX and remains unsupported unless a host sampler can
  provide it with explicit provenance.
- CPU and resident memory will be sampled for the renderer process tree by the benchmark
  orchestrator, independently of GPUIX.

Evidence was checked against the published npm tarballs and the matching upstream tags. Re-run this
readiness audit before changing either pinned version.

## Abbacchio workspace prerequisite

`packages/client` requests `@abbacchio/browser-transport` 0.3. Version 0.3.0 became available from
npm on 2026-08-24 UTC, with integrity
`sha512-aodXg1I+zFa3oZdcisC2OWMbYDkYBG9Yrg6Dql4oaDb1QVzI+uq0r+Y53hMKrZqA8O0iwH5qCaeN85HUqDmm/Q==`.
The benchmark dependency installation therefore no longer requires the existing local link. This
change only refreshes Funny's lockfile resolution; it does not modify or publish Abbacchio.
