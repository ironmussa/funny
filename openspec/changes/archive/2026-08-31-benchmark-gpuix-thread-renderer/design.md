## Context

The current browser benchmark renders deterministic long-thread fixtures through React DOM in
virtualized and fully retained modes. It uses Playwright and Chromium DevTools Protocol data for
browser-specific diagnostics, but it does not define a renderer-neutral workload protocol or count
the browser process tree when reporting memory. GPUIX is a React renderer backed by GPUI through a
native binding; it has different lifecycle, measurement, and retained-tree semantics and therefore
cannot be compared by reusing DOM counters or JavaScript heap alone.

Both browser and native stacks may use the GPU. The experiment compares React DOM/Chromium with
React/GPUIX/GPUI, not CPU rendering with GPU rendering. Results must attribute differences to the
complete renderer stack and preserve this qualification in generated reports.

GPUIX exposes virtual-list and native Markdown, code, and diff elements suitable for an equivalent
thread-view workload. GPUIX 0.5.1 also exposes aggregate debug-overlay draw statistics (`current`,
p90, p99, maximum, total frames, and sample count) plus painted-row bounds. It does not expose the
underlying raw presented-frame samples or a verified presentation acknowledgement. The benchmark
records the available aggregates as renderer-specific diagnostics without treating
input-to-present or frame-time data as comparable.

The repository also depends on `@abbacchio/browser-transport` 0.3. It was unpublished when this
design was drafted, but 0.3.0 became available from npm on 2026-08-24 UTC. This benchmark may refresh
the lockfile resolution but does not otherwise change Abbacchio.

## Goals / Non-Goals

**Goals:**

- Isolate shared fixtures, workload commands, result contracts, statistics, and verdict logic from
  either renderer.
- Run browser and GPUIX adapters as independent release-built child processes under one
  orchestrator.
- Capture raw samples and full provenance before deriving summaries or verdicts.
- Compare only metrics with the same operational definition and feature-equivalent workload.
- Fail explicitly as `unsupported`, `invalid`, or `inconclusive` when measurement evidence is not
  sufficient.

**Non-Goals:**

- Selecting GPUIX as the product renderer or establishing a production GPUIX architecture.
- Recreating navigation, authentication, transport, terminals, or the complete Funny UI.
- Treating a local benchmark as a universal claim across hardware and operating systems.
- Modifying or forking GPUIX merely to obtain a favorable measurement.
- Making performance thresholds merge-blocking on shared CI machines.

## Decisions

### Use two benchmark-only packages and a renderer-neutral contract

Add a private `@funny/client-benchmark` package for fixture v2, workload commands, result schema,
statistics, feature-equivalence checks, and verdict evaluation. Add a private
`@funny/client-gpuix-benchmark` package containing only the minimal GPUIX application and its
adapter. The existing browser harness remains in `@funny/client` initially and implements the same
contract.

The current long-thread fixture will remain available through a compatibility re-export. Fixture v2
will add any missing required feature, including an explicit diff, and will be immutable once result
artifacts reference its version.

This keeps experimental native dependencies out of the product client and prevents the benchmark
from silently becoming a second application. A single mixed package was rejected because its DOM
and native dependencies would make boundaries and supported hosts harder to enforce.

### Coordinate adapters through structured child-process messages

Add `scripts/profile-renderers.ts` as the top-level orchestrator. Each renderer runs in its own
process and exchanges versioned newline-delimited JSON commands and events over standard I/O. The
protocol includes lifecycle readiness, feature inventory, workload start/completion, presented-frame
acknowledgement when supported, raw renderer samples, errors, and shutdown.

Process isolation allows the orchestrator to sample the full descendant process tree and avoids
cross-renderer warm state. Directly importing both renderers into one process was rejected because
Chromium and native event loops have incompatible ownership and would contaminate CPU and memory
measurements.

### Establish measurement readiness before implementing verdict-bearing GPUIX metrics

The first implementation step will verify, against a pinned GPUIX version, whether a public API can
provide raw frame or presentation acknowledgements. A metric is comparable only when both adapters
can observe the same boundary:

- cold readiness: child-process spawn to an explicit first-content-presented event;
- interaction latency: orchestrator command receipt to the first presented frame containing the
  resulting state;
- frame time: consecutive presented frames attributable to the active workload.

GPUIX 0.5.1 does not expose the required boundary, so the adapter records the capability as
unsupported and the affected verdict is inconclusive. Its public aggregate overlay statistics are
retained under their native layout/draw meaning. Application timers, aggregate overlay values, and
command completion without presentation confirmation will not be relabeled as frame or
input-to-present measurements. Patching or maintaining a GPUIX fork requires a separate explicit
decision.

### Separate portable metrics from renderer-specific diagnostics

The portable comparison set is elapsed workload latency, process-tree CPU, process-tree resident
memory, and memory growth at quiescent checkpoints. Browser JavaScript heap, DOM node/layout counts,
GPUIX retained element counts, and GPU memory are diagnostics with explicit availability and source
labels. Browser heap is never compared directly with native RSS.

The process sampler resolves and totals the root process and descendants on each supported OS so
Chromium subprocesses are included. Unsupported counters remain nullable with a reason rather than
being reported as zero. GPU memory is best effort because portable per-process attribution is not
available on every host.

### Use controlled paired runs and retain all raw evidence

The default controlled profile uses release builds, a 1440 by 900 viewport, a fixed theme, fixture
v2, fixed workload sequences, warm-up runs, and repeated measured runs. Renderer order alternates in
an ABBA pattern to reduce temperature and background-load drift. Required environment controls
include source revision, dependency versions, OS and architecture, CPU/GPU identity, total memory,
power state when observable, refresh target, viewport, and build mode.

Each adapter emits raw observations; central code computes median, p95, p99, maximum, median absolute
deviation, budget-exceedance ratios, and bootstrap 95 percent confidence intervals. Keeping
summaries central prevents different implementations of percentile math. Samples are never deleted
from the JSON artifact, enabling later reanalysis.

### Define a small fixed workload suite

Both adapters implement the following state-driven scenarios:

1. cold start to first complete thread presentation;
2. 60 seconds of quiescent idle sampling;
3. the same deterministic scroll path, with the existing 41-step path retained where applicable;
4. switching between two equivalent 500-message threads;
5. deterministic streaming append and in-place update events;
6. controlled input/state change to confirmed presentation;
7. 100 alternating thread switches followed by quiescent memory sampling.

An equivalence validator compares fixture version, ordered message/tool counts, required feature
inventory, final state checksum, and visible/retained counts. Screenshots may support diagnosis but
are not the sole parity assertion because GPUIX screenshot automation is currently platform-limited.

### Keep verdict policy declarative and evidence-bounded

Thresholds from the capability specification live in a versioned policy object recorded in every
comparison. The evaluator first checks provenance, feature equivalence, capability availability,
sample sufficiency, and noise tolerance; it only then applies performance thresholds. It emits a
per-scenario and overall `go`, `no-go`, or `inconclusive` result with the exact contributing facts.

No measured value from the developer machine is baked in as a baseline. Existing observations can
be cited in a generated report as historical evidence only when accompanied by their original
artifact and provenance.

### Split CI smoke coverage from controlled performance runs

Unit and contract tests cover schemas, statistics, protocol handling, fixture parity, and verdict
logic. CI uses reduced fixtures and repetitions to prove that supported adapters launch and finish,
but it does not enforce timing thresholds. Controlled full runs are an explicit local or dedicated
machine command and produce artifacts under a gitignored results directory.

Initial controlled-run support targets macOS and Linux where the necessary native binary and process
sampling capabilities are present. Other hosts return a structured unsupported result until their
sampler and GPUIX runtime are validated.

## Risks / Trade-offs

- [GPUIX lacks exportable presentation telemetry] → Complete the capability spike first, report
  unsupported metrics explicitly, and issue an inconclusive verdict rather than using proxy timers.
- [The minimal renderer performs less work than the product web view] → Validate a required feature
  inventory and final-state checksum before any comparison is eligible for a verdict.
- [Process memory and CPU collection differs by OS] → Keep platform samplers behind one contract,
  test their process-tree aggregation, and record sampler/version provenance.
- [Native and Chromium startup include different one-time costs] → Report cold startup separately,
  alternate run order, and keep warm interaction measurements distinct.
- [Performance noise hides a real difference] → Preserve raw samples, report dispersion and
  confidence intervals, invalidate uncontrolled runs, and return inconclusive within noise tolerance.
- [Experimental dependencies destabilize the workspace] → Keep them in a private benchmark package
  and ensure unsupported hosts can still run schema and browser tests.
- [A fixture update invalidates historical comparisons] → Version fixtures immutably and reject
  cross-version pairing by default.
- [GPU usage is overinterpreted as the source of improvement] → Describe results as complete-stack
  comparisons and label GPU-specific counters separately.

## Migration Plan

1. Add shared contracts, fixture v2, validation, and statistics without changing the current browser
   benchmark command.
2. Adapt the current React DOM profiler to emit the new schema and confirm it reproduces the existing
   workload behavior.
3. Complete the GPUIX measurement-readiness spike, pin the supported dependency version, and record
   unsupported capabilities.
4. Add the minimal GPUIX renderer and orchestrator behind new benchmark-only commands.
5. Add smoke tests and documentation, then run the first controlled paired profile and retain its
   artifacts outside version control unless explicitly selected as documentation evidence.

Rollback consists of removing the two private benchmark packages and new scripts; product runtime
code and the existing browser benchmark remain usable throughout the migration.
