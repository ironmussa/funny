# Search backend comparison

Run the semantic comparison and benchmark from `packages/runtime`:

```sh
bun --bun vitest run src/__tests__/services/search-benchmark.test.ts
bun run bench:search
```

The benchmark creates isolated small, 10,000-file, and three-worktree fixtures,
also measures the current repository, and runs each backend in a separate Bun
process. The generated machine-readable report is `results.json`. Its default
iteration counts can be overridden with `SEARCH_BENCH_LARGE_FILES`,
`SEARCH_BENCH_FILE_ITERATIONS`, and `SEARCH_BENCH_CONTENT_ITERATIONS`.

## Recorded gate result

The Linux x64 / Bun 1.4.0 comparison recorded on 2026-08-31 did not pass the
replacement gate. All 12 semantic fixture tests passed. FFF improved warm
content-search latency, but did not improve warm file-search p50 or p95 by 20%
in any scenario. Cold readiness also exceeded the permitted 25% regression in
the generated small, large, and multi-worktree scenarios.

Representative measurements from `results.json`:

| Scenario | Backend | Cold ms | File p50/p95 ms | Content p50/p95 ms | RSS MiB | Watchers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Current repository | Current | 90.9 | 1.00 / 1.58 | 10.85 / 13.03 | 33.9 | 0 |
| Current repository | FFF | 106.6 | 2.62 / 4.40 | 2.30 / 6.29 | 45.5 | 341 |
| Large (10,000 files) | Current | 21.3 | 3.59 / 5.26 | 14.03 / 18.03 | 35.4 | 0 |
| Large (10,000 files) | FFF | 55.8 | 4.56 / 7.58 | 9.57 / 13.49 | 49.4 | 203 |
| Three worktrees | Current | 14.9 | 0.01 / 0.02 | 4.95 / 6.08 | 32.0 | 0 |
| Three worktrees | FFF | 157.0 | 0.68 / 1.08 | 0.22 / 0.45 | 30.7 | 12 |

Per the OpenSpec replacement requirement, production routing must remain on
the existing implementations unless a later FFF version or adapter change
passes the gate.
