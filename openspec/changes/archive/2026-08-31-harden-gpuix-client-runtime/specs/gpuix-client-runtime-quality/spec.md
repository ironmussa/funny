## Purpose

Defines observable resilience and verification guarantees for the experimental native GPUIX client while it remains pinned to the supported 0.5.1 runtime.

## ADDED Requirements

### Requirement: Long native diffs remain bounded and expandable

The GPUIX client SHALL initially bound the rendered lines of a large diff and SHALL provide an explicit action that reveals the complete diff without discarding the surrounding message or conversation state.

#### Scenario: Expand a truncated diff

- **WHEN** a message diff exceeds the native client's initial line limit
- **THEN** the client SHALL show that the diff is truncated and SHALL provide an action that renders the remaining lines

#### Scenario: Preserve the bounded initial render

- **WHEN** a message contains a diff at or below the initial line limit
- **THEN** the client SHALL render the diff without an unnecessary expansion action

### Requirement: Visual-parity capture waits for observable readiness

The GPUIX visual-parity capture SHALL verify that the expected fixture has reached a stable observable native presentation state before taking a screenshot, and SHALL fail with actionable evidence when readiness is not reached within a bounded timeout.

#### Scenario: Capture a ready fixture

- **WHEN** the expected fixture markers are present and stable on a screenshot-capable host
- **THEN** the capture SHALL take the screenshot and record supported evidence for that fixture

#### Scenario: Fixture does not become ready

- **WHEN** the expected fixture markers do not become stable before the configured timeout
- **THEN** the capture SHALL fail without publishing a successful screenshot record and SHALL identify the unmet readiness condition

#### Scenario: Host cannot capture native output

- **WHEN** the host lacks the pinned runtime's native screenshot capability
- **THEN** the capture SHALL record that presentation evidence is unsupported while preserving available structural evidence

### Requirement: Native frame diagnostics are explicitly enabled

The standard GPUIX client launch SHALL keep the native frame overlay hidden unless diagnostic mode is explicitly enabled, while benchmark and diagnostic entry points SHALL remain able to collect the native frame statistics they require.

#### Scenario: Standard client launch

- **WHEN** the GPUIX client starts without diagnostic mode
- **THEN** the native frame overlay SHALL remain hidden and SHALL NOT obscure application content

#### Scenario: Diagnostic client launch

- **WHEN** the GPUIX client starts with diagnostic mode explicitly enabled
- **THEN** it SHALL enable the configured native frame overlay and reset its sample window before collecting statistics

#### Scenario: Benchmark collection

- **WHEN** a benchmark entry point requests native draw statistics
- **THEN** diagnostic collection SHALL remain enabled independently of the standard client default

### Requirement: Native renderer failures remain readable

The GPUIX renderer error surface SHALL apply an explicit high-contrast foreground and background independent of the failed application theme tree and SHALL retain an actionable fallback instruction.

#### Scenario: Application render failure

- **WHEN** a descendant throws during native rendering
- **THEN** the error surface SHALL display a readable recovery heading, the error message, and instructions for restarting or using the web renderer

### Requirement: Supported hosts enforce native UI contracts

The GPUIX CI matrix SHALL run the `gpuix-ui` typecheck and test suite in addition to the product-client checks, and macOS and Windows runs SHALL treat available native renderer tests as required rather than silently replacing them with non-native evidence.

#### Scenario: Supported native CI host

- **WHEN** GPUIX verification runs on macOS or Windows with the native test renderer available
- **THEN** the `gpuix-ui` typecheck and all compatible native UI tests SHALL run and any failure SHALL fail the job

#### Scenario: Host lacks a native test renderer

- **WHEN** GPUIX verification runs on a host where the native test renderer is unavailable
- **THEN** the suite SHALL report the native tests as unsupported or skipped explicitly while still running portable contracts
