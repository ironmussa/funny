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
`SEARCH_BENCH_FILE_ITERATIONS`, `SEARCH_BENCH_CONTENT_ITERATIONS`, and
`SEARCH_BENCH_ROUNDS`. FFF file-search parallelism defaults to one thread and
can be changed with `SEARCH_BENCH_FFF_MAX_THREADS`; every report records the
chosen values.

The command exits non-zero when the comparison gate fails. This is expected for
the recorded 0.10.6 result below; the report is still written before exit.

## Native platform support

FFF is a required production dependency. Funny's desktop release matrix must
load the pinned `@ff-labs/fff-node` native library on:

- Windows x64 (`x86_64-pc-windows-msvc`)
- Linux x64 glibc (`x86_64-unknown-linux-gnu`)
- macOS arm64 (`aarch64-apple-darwin`)
- macOS x64 (`x86_64-apple-darwin`)

The package also publishes other binaries, but they are not Funny desktop
release targets in `.github/workflows/build.yml`. Adding a release target
requires adding a packaged native-load check for it; an unavailable binding is
a release-gate failure and search returns a controlled unavailable error. There
is no legacy runtime fallback.

Each release-matrix host runs the native gate before building:

```sh
bun run --cwd packages/runtime verify:fff-native <target-triple>
```

The gate requires the host and release triples to match, resolves the expected
platform package, loads its dynamic library, and checks the reported FFF
version. Unsupported targets and missing or unloadable libraries exit non-zero.

## State, cleanup, and diagnostics

FFF's disposable frecency and query-history databases are stored under:

```text
<FUNNY_DATA_DIR>/search/<runner-scope-sha256>/<canonical-cwd-sha256>/
  frecency.db
  history.db
```

`FUNNY_DATA_DIR` defaults to Funny's runner data directory. Both scope and cwd
are hashed, so absolute checkout paths are not directory names and different
runners/worktrees do not share ranking history. Normal idle eviction, worktree
or scratch deletion, and runtime shutdown dispose the native instance and its
watcher. Operators may remove an individual hashed directory, or the entire
`search` directory, only while the runtime is stopped; these files are caches
and will be rebuilt on the next search.

Authenticated operators can inspect `GET /api/search/health`. The response
reports the native availability/version, resident/active/initializing counts,
and per-entry scan, indexed-file, and watcher state. Working directories appear
only as short hashes, and failures appear only as stable categories such as
`native-load`, `initialization`, `scan`, or `health-check`; query text, matched
paths, file contents, and raw native errors are never returned.

Rollback is a source or release rollback to a version before this migration,
not a configuration switch. Stop the runtime before changing releases. The FFF
cache may be retained or deleted because it is not durable application data.

## Recorded gate result

The Linux x64 / Bun 1.4.0 comparison recorded on 2026-08-31 did not pass the
replacement gate. All 13 semantic fixture tests passed, but only the generated
large fixture produced identical indexed-file corpora. The current file index
includes ignored files while FFF excludes them, so the repository, small, and
multi-worktree latency rows are labeled non-equivalent and cannot establish a
ranking-performance win.

On the identical 10,001-file corpus, FFF improved warm content-search p50 and
p95 by more than 20%, but did not improve warm file-search p50 or p95 and both
file and content readiness exceeded the permitted 25% regression. The corpus
count and SHA-256 fingerprint in `results.json` make this equivalence check
reproducible. Product explicitly accepted these regressions on 2026-08-30 to
prioritize one maintained search implementation, so FFF is the sole production
backend despite the failed comparison gate.

Representative measurements from `results.json`:

| Scenario | Backend | File/content ready ms | File p50/p95 ms | Content p50/p95 ms | RSS MiB | Watchers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Current repository | Current | 20.0 / 20.0 | 0.42 / 1.29 | 11.28 / 12.86 | 32.5 | 0 |
| Current repository | FFF | 55.4 / 56.0 | 1.89 / 4.32 | 2.18 / 3.09 | 52.0 | 342 |
| Large (10,000 generated files) | Current | 26.8 / 26.8 | 0.69 / 1.46 | 14.62 / 17.14 | 33.3 | 0 |
| Large (10,000 generated files) | FFF | 55.7 / 56.2 | 5.17 / 7.63 | 5.97 / 10.49 | 100.2 | 203 |
| Three worktrees | Current | 19.1 / 19.1 | 0.00 / 0.02 | 5.07 / 6.21 | 34.8 | 0 |
| Three worktrees | FFF | 156.4 / 157.3 | 0.08 / 0.21 | 0.14 / 0.32 | 28.1 | 12 |

The `current` adapters and ripgrep binary referenced by this benchmark are
test-only baselines retained for repeatability. Production file and content
search always route through FFF. A later FFF version may improve the recorded
trade-offs, but it must update the pinned dependency, rerun this benchmark, and
replace `results.json` with the new evidence.

## Capability verification matrix

Every scenario in the `project-code-search` OpenSpec has automated coverage or
an explicit release/benchmark verification step:

| Scenario | Verification |
| --- | --- |
| Worktree thread search | `text-search.test.ts`: resolves an owned worktree before initializing file search |
| Unauthorized path search | `text-search.test.ts`: rejects another user's thread and denied project paths before initialization |
| Fuzzy file query | `search-benchmark.test.ts`: respects ignores and returns typo-tolerant ranked files |
| Result limit | `fff-project-search-provider.test.ts`: returns capped ranked file results; `browse-files-search.test.ts`: reports truncation |
| Ignored file | `search-benchmark.test.ts`: respects ignores and returns typo-tolerant ranked files |
| Plain-text content search | `fff-project-search-provider.test.ts`: preserves plain, regex, case, whole-word, glob, range, and cap semantics |
| Supported option translation | The same provider contract test covers combined options and result parity |
| Invalid regular expression | Provider and benchmark tests assert a controlled error and a later successful search |
| File created during a thread | `search-benchmark.test.ts`: discovers a post-initialization file through the native watcher |
| Branch-changing Git operation | `project-search-registry.test.ts`: refreshes status, rescans branch changes, and wires Git events |
| Native dependency unavailable | `search-fff-failures.test.ts`: returns a controlled native-load error |
| Resident query failure | `search-fff-failures.test.ts`: returns a controlled error without invoking ripgrep |
| Concurrent searches in one worktree | `project-search-registry.test.ts`: canonicalizes cwd and shares concurrent initialization |
| Worktree deletion | `worktrees.test.ts` and `thread-service-update.test.ts`: invalidate the removed worktree's exact search entry |
| Runtime shutdown | `project-search-registry.test.ts`: disposes every resident provider during shutdown cleanup |
| Native failure diagnosis | Provider and registry diagnostics tests assert sanitized categories without raw reasons |
| Search telemetry | `fff-project-search-provider.test.ts`: emits content-free operation logs and metrics |
| Benchmark gate passes | `bun run bench:search` evaluates parity and all latency/readiness thresholds and exits zero only when they pass |
| Benchmark gate fails | The same command exits non-zero and writes `results.json`; the recorded 0.10.6 run verifies this path |
| Product accepts benchmark regressions | The recorded gate result above and the OpenSpec decision document the 2026-08-30 acceptance and sole-backend policy |

Release-platform loading is additionally enforced by
`verify:fff-native <target-triple>` in every desktop build-matrix row.
