# Funny: Bun vs tsrs benchmark

Bun 1.4.3; tsrs 0.18.0-ts7.1.0-dev.20260929; commit c404f4b04. Linux x64, 20 logical CPUs.

CLI wall time including process startup; sequential runs, alternating tool order; first round discarded as warmup, median of three measured rounds. Default worker settings; identical project configs; tsrs --noEmit, bun check --all. Dependencies installed beforehand. RSS is peak per invocation from GNU time.

| Project                                       | Bun seconds | tsrs seconds | Bun MiB | tsrs MiB |
| --------------------------------------------- | ----------: | -----------: | ------: | -------: |
| packages/client-core/tsconfig.json            |       0.450 |        0.239 |   138.2 |     91.4 |
| packages/client-benchmark/tsconfig.json       |       0.082 |        0.091 |    97.2 |     48.5 |
| packages/client-gpuix-benchmark/tsconfig.json |       0.480 |        0.234 |   157.7 |     91.0 |
| packages/client-gpuix/tsconfig.json           |       0.587 |        0.326 |   219.7 |    147.2 |
| packages/gpuix-ui/tsconfig.json               |       0.477 |        0.254 |   135.0 |     85.1 |
| packages/ui-contracts/tsconfig.json           |       0.391 |        0.182 |   107.4 |     75.8 |
| scripts/renderer-benchmark/tsconfig.json      |       0.529 |        0.233 |   190.2 |    111.6 |
| packages/client/tsconfig.json                 |       1.701 |        2.422 |   650.1 |    734.0 |
| packages/runtime/tsconfig.json                |       1.165 |        1.092 |   549.3 |    630.4 |
| packages/server/tsconfig.json                 |       0.889 |        0.840 |   513.0 |    491.1 |
| packages/shared/tsconfig.json                 |       0.678 |        0.424 |   359.5 |    198.5 |
| packages/harness/tsconfig.json                |       0.339 |        0.265 |   217.1 |    119.4 |
| packages/agent/tsconfig.json                  |       0.784 |        0.673 |   341.3 |    214.4 |
| packages/sdk/tsconfig.json                    |       0.446 |        0.238 |   168.8 |    118.3 |
| packages/scheduler/tsconfig.json              |       0.590 |        0.363 |   281.7 |    177.4 |

bun measured round totals: [9.875799699992058, 9.564201253015199, 9.213809747918276]; median 9.564s

tsrs measured round totals: [8.411057129022083, 7.772005121965776, 7.523326464026468]; median 7.772s

Diagnostic differences: []

Existing diagnostic: packages/shared/src/**tests**/repositories/message-repository.test.ts(537,14): TS2774. Bun exits 1, tsrs exits 2. All other projects exit 0.
