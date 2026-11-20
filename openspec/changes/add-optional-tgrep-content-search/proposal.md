## Why

The user selected tgrep after evaluating its search behavior and requested removal of FFF and its native dependency.

## What Changes

- Use tgrep 1.0.5 exclusively for content search, with explicit errors and retry on subsequent queries.
- Use Git file enumeration and Funny's shared fuzzy scorer for file search, with periodic refresh and scratch-directory support.
- Remove FFF, native CI verification, shadow comparison and rollback configuration.
- Preserve scoped process lifecycle, bounded results and cancellation.

## Capabilities

### New Capabilities

- `tgrep-shadow-search`: Scoped tgrep content search and independent file ranking, superseding the initial comparison experiment.

### Modified Capabilities

## Impact

Runtime providers, dependencies and lockfile, CI, regression tests and operator documentation. No frontend or authorization changes. The tgrep executable must be installed separately.
