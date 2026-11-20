# gpuix-file-manager-performance Specification

## Purpose

Keeps the native project file manager responsive by bounding retained rows to the visible viewport and makes that cost reproducible in renderer benchmarks.

## Requirements

### Requirement: Viewport-aware file-tree retention

The native file manager SHALL retain a bounded window derived from the visible file-tree range plus a small overscan margin, rather than retaining a fixed large row count independent of viewport size. The retained window MUST continue to cover every visible row while browsing, filtering, expanding, collapsing, or scrolling the tree.

#### Scenario: Populated project initially loads

- **WHEN** a project with more rows than fit in the file-manager viewport is loaded
- **THEN** the native tree retains the visible rows and bounded overscan without mounting the previous fixed 96-row window

#### Scenario: User scrolls through a large tree

- **WHEN** the visible range moves beyond the current retained window
- **THEN** the retained window moves to cover the new visible range and preserves valid logical row indexes

#### Scenario: Viewport size changes

- **WHEN** the native viewport grows or shrinks
- **THEN** the retained row count adapts while remaining bounded by the total row count

### Requirement: Representative populated-project benchmark

The GPUIX product benchmark SHALL load a deterministic populated project file tree and SHALL report retained and visible file-tree row counts separately from transcript counts.

#### Scenario: Product benchmark reaches ready state

- **WHEN** the GPUIX product benchmark observes the rendered application
- **THEN** its diagnostics identify a non-empty file tree and report how many file-tree rows are retained and visible

#### Scenario: Benchmark streaming workload runs

- **WHEN** consecutive streaming mutations are measured
- **THEN** the visible assistant content grows across revisions so that the workload exercises real rendered-content updates alongside the populated file manager
