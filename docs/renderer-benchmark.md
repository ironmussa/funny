# Renderer benchmark

This benchmark compares the complete **React DOM/Chromium** and **React/GPUIX/GPUI** stacks. Both
may use GPU acceleration. Results must not be described as a CPU-versus-GPU comparison.

## What it measures

Both adapters receive the immutable `long-thread-v2` fixtures: two 500-message conversations with
the same Markdown, code, table, tool-call, and diff workload. The controlled suite covers cold
readiness, idle operation, 41-step scrolling, thread switching, streaming updates, controlled input
updates, and 100 repeated thread switches.

The full GPUIX product adapter also mounts a deterministic 1,200-file nested project in the Files
dock. Its diagnostics report `fileTreeFileCount`, `fileTreeRetainedItemCount`, and
`fileTreeVisibleItemCount` separately from transcript row counts. Streaming revisions grow a
sub-400-character assistant message on every step, so each mutation changes content that the native
message preview actually renders. These product-only diagnostics make the cost of a selected
project auditable; they are not cross-renderer metrics because the web benchmark surface does not
mount the same product shell.

Portable measurements include process-tree CPU and resident memory. Frame time and
input-to-present are comparable only when both renderers expose the required presentation boundary.
JavaScript heap, DOM counters, native retained elements, painted elements, screenshots, aggregate
native draw statistics, and GPU memory are renderer-specific diagnostics and are never compared as
if they had identical meaning.

GPUIX 0.5.1 exposes painted-row bounds and aggregate debug-overlay statistics: current, p90, p99,
maximum, total frame count, and sample count. The product profiler resets the overlay samples for
each workload and records those values in the workload diagnostics. GPUIX still does not expose the
underlying raw draw samples or a verified presentation acknowledgement through its public API.
Consequently, the overlay can diagnose native layout/draw cost but cannot establish frame-by-frame
or input-to-present latency. Per-process GPU memory also remains unavailable. The generated
`comparison.md` displays the aggregates in a dedicated GPUIX overlay table.

The product streaming workload follows the same lightweight path as the real client: every
intermediate message carries streaming delivery and renders as bounded native text, then ordinary
durable messages use the selected Rich/Fast mode. Header, composer, and permission subscriptions
select stable run/access/permission values, so a content-only benchmark delta does not reconcile
those controls. The adapter establishes the active streaming row before resetting statistics, so
`streaming-update` measures fragment updates rather than the distinct rich-to-streaming transition.
Use the diagnostic `Reset stats` action before manual comparisons; automated workloads reset the
same renderer sample window programmatically.

## Controlled run

Prepare a quiet macOS or glibc Linux machine on AC power. Close unrelated heavy applications, use a
release checkout with a clean dependency install, and avoid changing display configuration during
the run. The profiler records the source revision, dependency stack, OS, architecture, CPU, GPU when
available, total memory, power state, viewport, refresh target, build mode, and timestamps.

Each measured repeated-navigation workload first performs one identical 100-switch stabilization
pass in both renderers. Process-tree memory growth is then calculated from the following 100-switch
pass after quiescence, so one-time allocator and second-thread initialization are outside the
retained-growth window.

Run the full profile:

```bash
bun run profile:renderers
```

The default performs one warm-up per renderer and four measured sessions per renderer. React DOM
virtual and GPUIX alternate in ABBA order. The frozen React DOM viewer is recorded as a diagnostic
baseline. A full run includes 60-second idle workloads and may take several minutes.

For a non-gating contract smoke:

```bash
bun run profile:renderers:smoke
```

The command prints a directory under `benchmark-results/`. Generate the paired report with:

```bash
bun scripts/compare-renderers.ts --dir=benchmark-results/<timestamp>
```

The directory contains raw samples and summaries in renderer JSON files plus `comparison.json` and
`comparison.md`. The directory is gitignored so repeated runs do not overwrite or accidentally
commit machine-local evidence.

## Interpreting a result

The comparator first verifies source, fixture, viewport, build, hardware, power, refresh, and
feature equivalence. It then labels metrics as directly comparable or renderer-specific and applies
the versioned thresholds recorded in the JSON report. The outcome is `go`, `no-go`, or
`inconclusive` per scenario and overall.

Do not copy a median from one machine into source as a universal baseline. Compare later runs only
when their schema and fixture versions match and their provenance controls pass. Hardware or runtime
changes require a new paired run; historical artifacts may provide context but not an automatic
verdict.

## Unsupported hosts and failures

Controlled performance runs currently support macOS and Linux. Contract/schema tests continue on
other hosts through `bun run test:renderer-benchmark`, while the native profiler writes a
schema-valid `gpuix.json` with `status: "unsupported"`. Adapter crashes,
timeouts, malformed output, missing capabilities, and mismatched controls invalidate the pair rather
than silently dropping samples.
