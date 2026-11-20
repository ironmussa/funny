## Context

The GPUIX host virtual list only creates native elements for React children supplied by the application. The current file tree always supplies 96 rows and requests 240 px of native overdraw; this dominates paint cost after project selection. The host reports an exclusive visible logical range after layout and exposes the current window size through the React integration. See `proposal.md` for motivation and `specs/gpuix-file-manager-performance/spec.md` for required behavior.

The product benchmark renders the full native shell but its file-tree service is never populated, and its streaming mutation repeatedly appends a suffix to a source message whose visible prefix remains unchanged.

## Goals / Non-Goals

**Goals:**

- Bound initial retention before the first visible-range event.
- Adapt retention to measured visible rows with enough overscan to avoid gaps during normal scrolling.
- Keep logical `windowStart`, selection, filtering, and folder toggling correct as the window size changes.
- Measure file-tree retention and realistic streaming in the full-shell benchmark.

**Non-Goals:**

- Replacing GPUIX's native virtual-list implementation.
- Changing file-index APIs, the 10,000-file service cap, or the web file manager.
- Removing file/folder icons or changing the visual hierarchy in this iteration.

## Decisions

### Derive the initial window from host height, then refine it from native visibility

The initial retained count will use `ceil(windowHeight / estimatedRowHeight)` plus bounded row overscan. Once `onVisibleRange` supplies actual indexes, the component will derive the exact visible count and retain that count plus overscan on both sides. This avoids the expensive 96-row first paint while tolerating the file dock being shorter than the whole window. A hard minimum protects small or temporarily unknown layouts, and a hard maximum guards malformed native events.

Alternative considered: start with 96 and shrink after layout. This retains the observed project-load spike and therefore does not meet the primary goal.

### Use row-count overscan and reduce native pixel overdraw

React retention will use a small symmetric row buffer, while native overdraw will be reduced to approximately three estimated rows. Keeping both values explicit makes their costs testable. Zero overscan was rejected because fast wheel/trackpad movement could expose missing rows between React commits.

### Preserve the anchor when retained capacity changes

Every visible-range event will calculate the next capacity and then clamp/recenter `windowStart` using that same capacity. State will update only when either value changes, avoiding redundant reconciliations and inconsistent calculations from separate state updates.

### Populate the benchmark through the existing file-tree state boundary

The benchmark will install a deterministic nested file list directly into the application file-tree store after selecting its profile thread. Diagnostics will traverse automation test IDs to report transcript and file-tree counts independently. This avoids benchmark-only product components and external filesystem/network timing.

The streaming fixture will retain the evolving content separately and append meaningful text to it each revision, ensuring the rendered prefix changes on every measured mutation.

## Risks / Trade-offs

- [Visible-range callbacks include native overdraw and may overestimate on some hosts] → Clamp capacity and assert an upper bound relative to the reported range.
- [A resize can briefly use the conservative whole-window estimate] → The initial estimate is an upper bound and the next native visibility event refines it.
- [Too little overdraw can reveal blank rows during unusually large jumps] → Keep symmetric React overscan and validate direct scroll-to-item jumps in the native test renderer.
- [Benchmark fixture adds baseline paint work to all workloads] → This is intentional for product-shell representativeness; report counts so comparisons remain auditable.

## Migration Plan

Ship as an internal rendering change with no data migration. Rollback consists of restoring the fixed retained count and prior benchmark fixture; file-index state and public APIs remain compatible.
