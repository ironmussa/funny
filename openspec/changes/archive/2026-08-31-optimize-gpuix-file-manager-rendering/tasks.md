## 1. Adaptive File-Tree Window

- [x] 1.1 Add unit coverage for initial viewport-derived capacity, capacity clamps, and visible-range-derived retention.
- [x] 1.2 Replace the fixed 96-row file-tree window with adaptive retained-window state and reduce native overdraw.
- [x] 1.3 Add native renderer coverage for initial retention, large scroll jumps, filtering, and viewport-size differences.

## 2. Representative Product Benchmark

- [x] 2.1 Populate the GPUIX product benchmark file tree with a deterministic nested project fixture.
- [x] 2.2 Report retained and visible file-tree row diagnostics independently from transcript rows.
- [x] 2.3 Make streaming benchmark mutations grow visible assistant content and add regression coverage for benchmark fixture/diagnostic behavior.

## 3. Documentation and Verification

- [x] 3.1 Document the populated-project benchmark and adaptive file-tree retention evidence.
- [x] 3.2 Run focused package tests and the renderer smoke benchmark supported by the current host.
- [x] 3.3 Run React Doctor, repository lint and typecheck, and strict OpenSpec validation.
