## Context

The registry owns canonical-cwd providers, leases, idle eviction and Git refresh. The final requested scope removes FFF entirely.

## Goals / Non-Goals

Serve content using tgrep and file matches using shared smart-case fuzzy ranking. No binary bundling, selection-history ranking, shadow comparison or fallback engine.

## Decisions

- Enumerate tracked and untracked nonignored files with Git; scratch directories use the existing directory walker. Refresh every two seconds and after Git operations, coalescing overlapping scans. Increment the provider version when paths change.
- Start tgrep 1.0.5 lazily using `FUNNY_TGREP_BINARY` or `~/.local/bin/tgrep`. Use argv without a shell, private scoped temporary state, owned-child discovery and loopback JSON-RPC.
- Bound readiness to 30 seconds, RPC to 10 seconds and replies to 8 MiB. Default to 1,000 content rows, capped at 10,000.
- Failed content queries return sanitized errors, dispose the failed client and retry lazily on the next query. File search is independent. Rescan and disposal reject stale results.
- Dispose owned processes and state on rescan, eviction and shutdown. Expose backend and provider health without native-binding diagnostics.

## Risks / Trade-offs

File updates can take two seconds to appear. Selection history no longer affects ranking. tgrep omits hidden content paths and differs on long lines and accented-uppercase folding. Its local server has no application authentication.

## Migration Plan

Install tgrep 1.0.5 separately and restart the runtime. FFF rollback and shadow configuration are removed. No database migration is required.
