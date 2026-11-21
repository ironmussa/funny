## ADDED Requirements

### Requirement: Opt-in development memory profiler

The Abbacchio browser transport SHALL provide a configurable memory profiling
API. The Funny client SHALL install it in development builds and in builds where
OTLP telemetry is configured, and the profiler SHALL remain stopped until
explicitly started.

#### Scenario: Development startup

- **WHEN** the Funny client starts in a development build
- **THEN** the profiling API is available without starting a sampling timer

#### Scenario: Production build without telemetry

- **WHEN** the Funny client is built for production without an OTLP endpoint
- **THEN** the profiling implementation is excluded from the startup path

#### Scenario: Production build with telemetry

- **WHEN** the Funny client is built for production with OTLP configured
- **THEN** the profiling API is available for an operator to start on demand and remains stopped until then

#### Scenario: Application-specific diagnostics

- **WHEN** a browser application configures custom DOM selectors and a value collector
- **THEN** Abbacchio includes copied values from those extensions without depending on application code

### Requirement: Bounded periodic samples

The profiler SHALL record timestamped heap, DOM, Funny resource, and Browser
Panel lifecycle counters at a configurable interval while retaining no more
than its configured maximum number of samples.

#### Scenario: Profiling exceeds retention capacity

- **WHEN** a profiling run records more samples than its configured capacity
- **THEN** the oldest samples are discarded and the retained count remains bounded

#### Scenario: Browser lacks heap metrics

- **WHEN** the browser does not expose Chrome's JavaScript heap metrics
- **THEN** the profiler records null heap values and continues collecting other counters

### Requirement: Value-only diagnostic data

The profiler SHALL retain only serializable diagnostic values and SHALL NOT
retain DOM nodes, image/frame contents, React components, or application store
objects.

#### Scenario: Samples are inspected

- **WHEN** a developer retrieves recorded samples
- **THEN** the profiler returns copied serializable values that cannot mutate its internal history

### Requirement: Browser Panel frame correlation

The client SHALL expose cumulative counts for Browser Panel frame receipt,
payload size, decode starts, decode completions, decode failures, and decode
supersession without changing frame rendering behavior.

#### Scenario: New frame replaces a pending decode

- **WHEN** a frame arrives while the reused image still has a pending decode
- **THEN** the superseded-decode counter increases and the newest frame continues through the existing rendering path

#### Scenario: Browser session diagnostics are cleared

- **WHEN** the client clears the latest retained frame for a browser session
- **THEN** per-session diagnostic state is removed while bounded cumulative totals remain available

### Requirement: Durable profiling runs

Recorded samples SHALL be published to Abbacchio as gauge metrics identified by a
run identifier shared across the run, so a profiling run can be queried after the
page that produced it is gone. Publication SHALL NOT be able to interrupt
sampling.

#### Scenario: Sample is recorded while telemetry is configured

- **WHEN** the profiler records a sample and OTLP is configured
- **THEN** heap, DOM, and Browser Panel counters are published as gauge points carrying the run identifier, sample kind, sequence, and any label

#### Scenario: Counter is unavailable

- **WHEN** the browser does not expose heap metrics
- **THEN** the corresponding series are omitted instead of being published as zero

#### Scenario: Metric sink fails

- **WHEN** publishing a sample fails
- **THEN** sampling continues and the retained in-memory history is unaffected

#### Scenario: Stored run is analyzed

- **WHEN** an operator queries stored metrics by run identifier
- **THEN** the run's samples and marks are returned as an ordered time series

### Requirement: Profile export and experiment runbook

The profiler SHALL support JSONL export, and repository documentation SHALL
define a repeatable idle, thread, Browser Panel, and terminal experiment with
guidance for distinguishing JavaScript retention from Chrome-native memory.

#### Scenario: Profile is downloaded

- **WHEN** a developer requests a download after collecting samples
- **THEN** the browser downloads one JSON object per line without message or frame contents
