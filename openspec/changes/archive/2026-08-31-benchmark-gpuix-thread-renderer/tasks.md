## 1. Measurement Readiness and Package Boundaries

- [x] 1.1 Pin candidate `@gpuix/native` and `@gpuix/react` versions and record their supported host and build requirements
- [x] 1.2 Verify whether the pinned GPUIX public API exposes raw presented-frame or frame-timing events and document the evidence
- [x] 1.3 Define structured supported and unsupported capability records for frame timing, presentation acknowledgement, GPU memory, screenshots, and process sampling
- [x] 1.4 Confirm the Abbacchio 0.3 registry or local-link prerequisite without changing or publishing Abbacchio as part of this change
- [x] 1.5 Add private `@funny/client-benchmark` and `@funny/client-gpuix-benchmark` workspace package skeletons with enforced DOM-free shared boundaries

## 2. Shared Fixtures and Benchmark Contracts

- [x] 2.1 Define the versioned NDJSON command and event protocol for renderer lifecycle, capabilities, workloads, raw samples, errors, and shutdown
- [x] 2.2 Define the versioned JSON result schema for renderer runs, environment provenance, raw samples, summaries, validity, and unsupported reasons
- [x] 2.3 Add runtime validation with actionable errors for protocol messages and result artifacts
- [x] 2.4 Move the deterministic long-thread generator into the shared benchmark package while preserving the current client import through a compatibility re-export
- [x] 2.5 Add immutable fixture v2 with two 500-message threads and explicit Markdown, code, table, tool-call, and diff content
- [x] 2.6 Add a deterministic feature inventory and final-state checksum for each fixture and workload
- [x] 2.7 Define renderer-neutral workload descriptions for cold readiness, idle, scroll, switch, streaming, input/state change, and 100-switch memory cycling
- [x] 2.8 Add unit tests for fixture determinism, protocol validation, schema-version rejection, workload definitions, and compatibility exports

## 3. Statistics, Validity, and Verdict Evaluation

- [x] 3.1 Implement central summary calculations for median, p95, p99, maximum, median absolute deviation, invalid count, and frame-budget exceedance ratios
- [x] 3.2 Implement deterministic bootstrap 95 percent confidence intervals with a recorded seed
- [x] 3.3 Implement paired-run validation for fixture, viewport, theme, build mode, dependency versions, hardware, power state, and refresh target
- [x] 3.4 Implement feature-equivalence validation using inventory, ordered counts, final checksum, and retained and visible item counters
- [x] 3.5 Encode the default go/no-go thresholds in a versioned policy object included in result artifacts
- [x] 3.6 Implement per-scenario and overall `go`, `no-go`, and `inconclusive` evaluation with human-readable evidence
- [x] 3.7 Add unit tests for percentile edge cases, confidence intervals, invalid pair rejection, missing capabilities, noise tolerance, and every verdict outcome

## 4. React DOM Benchmark Adapter

- [x] 4.1 Adapt the existing browser benchmark to accept shared protocol commands without removing its current direct command
- [x] 4.2 Render fixture v2 in virtual and frozen modes with the required feature inventory and deterministic state checksum
- [x] 4.3 Emit explicit first-content-presented and post-interaction-presented acknowledgements from measured animation frames
- [x] 4.4 Emit raw scroll, switch, streaming, input/state-change, idle, and repeated-navigation observations
- [x] 4.5 Preserve CDP JavaScript heap, DOM node, and layout counters as labeled browser-only diagnostics
- [x] 4.6 Add adapter contract tests and verify that the shared workload reproduces the existing browser profiler's behavior

## 5. Minimal GPUIX Benchmark Renderer

- [x] 5.1 Build a benchmark-only GPUIX window with the fixed viewport, theme, and controlled lifecycle
- [x] 5.2 Implement message, Markdown, code, tool-call, table, and diff rendering for fixture v2 using GPUIX primitives
- [x] 5.3 Implement the long-thread view with GPUIX virtual-list behavior and report retained and visible item counts
- [x] 5.4 Implement protocol-driven scroll, thread switch, streaming append/update, input/state change, idle, and repeated-navigation workloads
- [x] 5.5 Emit real presentation and frame samples only through the verified GPUIX capability and otherwise emit structured unsupported records
- [x] 5.6 Emit GPUIX retained-element and available native renderer counters as labeled diagnostics
- [x] 5.7 Add deterministic renderer tests for feature inventory, final checksum, workload completion, and unsupported-capability behavior

## 6. Orchestration and Host Sampling

- [x] 6.1 Add `scripts/profile-renderers.ts` to build, launch, supervise, and cleanly terminate renderer child processes
- [x] 6.2 Implement warm-up and measured repetitions with alternating ABBA renderer order
- [x] 6.3 Implement source, runtime, dependency, CPU, GPU, memory, OS, architecture, viewport, refresh, power, and timestamp provenance collection
- [x] 6.4 Implement and test descendant-process discovery plus total RSS and CPU sampling on supported macOS and Linux hosts
- [x] 6.5 Add quiescence detection and initial, peak, final, percentage-growth, and fitted-slope memory calculations
- [x] 6.6 Reject mismatched or uncontrolled paired runs before comparison and retain their artifacts with invalid reasons
- [x] 6.7 Write raw and summarized schema-validated artifacts to a gitignored benchmark-results directory without overwriting prior runs
- [x] 6.8 Handle child crashes, timeouts, unsupported hosts, and partial artifacts with deterministic cleanup and actionable errors

## 7. Comparison Report and Reproducibility

- [x] 7.1 Generate a machine-readable paired comparison from two compatible renderer artifacts
- [x] 7.2 Generate a concise Markdown report separating comparable metrics, renderer-specific diagnostics, configured targets, and measured facts
- [x] 7.3 Include per-scenario confidence, validity, capability gaps, threshold evidence, and the overall evidence-bounded verdict
- [x] 7.4 Label the experiment as React DOM/Chromium versus React/GPUIX/GPUI rather than CPU versus GPU
- [x] 7.5 Document controlled machine preparation, release builds, commands, artifact locations, schema versions, and interpretation limits
- [x] 7.6 Document how to compare a later machine run without treating the initial local result as a universal baseline

## 8. Automated and Manual Verification

- [x] 8.1 Add reduced-sample CI smoke coverage for shared contracts, the browser adapter, report generation, and GPUIX where the native host is supported
- [x] 8.2 Verify unsupported native hosts return structured results while shared and browser coverage continue
- [x] 8.3 Run focused unit, contract, and adapter tests for every new package and script
- [x] 8.4 Run `bun run lint` and resolve new errors introduced by this change
- [x] 8.5 Run `bun run typecheck` and resolve new errors introduced by this change
- [x] 8.6 Run the complete repository test suite and confirm existing browser performance coverage remains green
- [x] 8.7 Execute one controlled paired release profile, validate its artifacts, and review feature-equivalence evidence before accepting its verdict
- [x] 8.8 Record the controlled run's limitations and any unsupported GPUIX metrics in the generated report and implementation handoff
