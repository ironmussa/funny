## Purpose

Defines a reproducible, provenance-aware performance comparison between Funny's React DOM thread
viewer and a minimal GPUIX renderer without confusing renderer effects with fixture or feature
differences.

## ADDED Requirements

### Requirement: Equivalent renderer workload

The benchmark SHALL run each renderer against the same versioned conversation fixtures, viewport,
theme, visible content, interaction sequence, pagination state, and rendering features. A result
MUST be marked incomparable when a renderer omits content or work required by the scenario.

#### Scenario: Equivalent long-thread scroll

- **WHEN** the benchmark runs the long-thread scenario for React DOM and GPUIX
- **THEN** both renderers SHALL receive the same ordered 500-message fixture and execute the same
  warm-up and measured scroll path
- **AND** the result SHALL record the retained and visible item counts for each renderer

#### Scenario: Missing feature parity

- **WHEN** one renderer cannot display a fixture feature required by the scenario, such as Markdown,
  code, or a diff
- **THEN** the comparison SHALL identify the unsupported feature and SHALL NOT issue a performance
  verdict for that scenario

### Requirement: Controlled repeated measurement

The benchmark SHALL separate warm-up runs from measured runs, execute enough repetitions to report
distributions, alternate renderer order to reduce machine drift, and reject runs affected by unmet
environment controls.

#### Scenario: Valid measured run

- **WHEN** both renderers complete their warm-ups and the configured measured repetitions under the
  same machine controls
- **THEN** the report SHALL include sample count, median, p95, p99, maximum, dispersion, and invalid
  sample count for every timing metric

#### Scenario: Invalid environment

- **WHEN** viewport, build mode, renderer version, fixture version, power state, or another required
  control differs between paired runs
- **THEN** the report SHALL mark the pair invalid, list the mismatched controls, and SHALL NOT issue a
  go/no-go verdict

### Requirement: Comparable performance metrics

The benchmark SHALL measure cold content readiness, steady idle behavior, scroll frame time,
thread-switch latency, streaming-update latency, input-to-present latency, process CPU, process-tree
resident memory, and repeated-navigation memory growth using renderer-neutral definitions.

#### Scenario: Frame-budget accounting

- **WHEN** a scroll, input, or streaming workload completes
- **THEN** the result SHALL report timing distributions and the proportion of samples exceeding the
  16.67 millisecond and 8.33 millisecond frame budgets

#### Scenario: Memory comparison

- **WHEN** a paired workload reaches its defined quiescent sampling points
- **THEN** the result SHALL report total process-tree resident memory and its growth from the paired
  baseline
- **AND** JavaScript heap, DOM counters, native retained elements, and GPU memory SHALL be reported
  only when available and labeled as renderer-specific diagnostics

#### Scenario: Repeated navigation

- **WHEN** the benchmark alternates between the two long-thread fixtures 100 times and then reaches
  quiescence
- **THEN** it SHALL report initial, peak, final, and fitted memory-growth slope rather than treating
  cumulative allocation or traffic counters as retained memory

### Requirement: Provenance and machine-readable results

Every benchmark execution SHALL emit a schema-validated JSON artifact containing the raw samples,
summaries, workload identity, renderer identity, source revision, build configuration, and hardware
and operating-system provenance needed to reproduce or qualify the result.

#### Scenario: Complete result artifact

- **WHEN** a benchmark run finishes successfully
- **THEN** its JSON artifact SHALL identify the schema version, git revision, fixture version,
  renderer and runtime versions, OS, architecture, CPU, GPU, memory, viewport, refresh target, build
  mode, timestamps, warm-up count, measured count, and raw samples

#### Scenario: Schema incompatibility

- **WHEN** a comparison tool receives an artifact with an unsupported schema version or missing
  required provenance
- **THEN** it SHALL reject the artifact with an actionable validation error instead of silently
  comparing it

### Requirement: Evidence-bounded verdict

The comparison report SHALL distinguish measured facts from configured targets and SHALL produce
`go`, `no-go`, or `inconclusive` per scenario and overall without presenting a single-machine run as
a universal GPUIX performance claim.

#### Scenario: Default go thresholds

- **WHEN** all paired scenarios are valid and feature-equivalent
- **THEN** a default `go` verdict SHALL require GPUIX scroll p95 at or below 16.67 milliseconds,
  thread-switch median no more than 10 percent slower than the virtual React DOM viewer, fewer than
  1 percent of measured interaction samples beyond 16.67 milliseconds, no retained-memory growth
  above 5 percent after the repeated-navigation workload, and at least a 20 percent improvement in
  either process-tree resident memory or input-to-present p95

#### Scenario: Insufficient evidence

- **WHEN** required metrics are unavailable, run validity fails, feature equivalence fails, or the
  observed difference is within configured noise tolerance
- **THEN** the affected verdict SHALL be `inconclusive` and the report SHALL explain which additional
  evidence is required

### Requirement: Safe automated coverage

The repository SHALL provide deterministic smoke and contract tests for both benchmark adapters
without making noisy native performance thresholds a merge-blocking unit-test gate.

#### Scenario: Continuous integration smoke run

- **WHEN** repository tests run on a supported CI host
- **THEN** they SHALL validate fixture parity, result-schema validation, workload completion, and
  report generation with reduced sample counts
- **AND** they SHALL NOT fail solely because a shared runner misses a performance target

#### Scenario: Unsupported native host

- **WHEN** the GPUIX native binary or required measurement capability is unavailable on the current
  platform
- **THEN** the native benchmark SHALL report a structured unsupported result while schema and React
  DOM coverage continue to run
