## 1. Experimental backend

- [x] 1.1 Implement validated bounded JSON-RPC search and owned process lifecycle for tgrep 1.0.5.
- [x] 1.2 Add nonblocking shadow composition, explicit configuration, sanitized comparisons and rescan/disposal handling.

## 2. Verification and operation

- [x] 2.1 Add regression tests for protocol failures, cancellation, result parity, default behavior and registry lifecycle.
- [x] 2.2 Run a real-binary smoke test covering searches, worktree isolation and rescan cleanup; document activation and limitations.
- [x] 2.3 Run lint, typecheck, targeted tests and strict OpenSpec validation; record outcomes.

## Validation results

- Targeted Vitest suite: 4 files, 27 tests passed, including the opt-in real tgrep 1.0.5 smoke test.
- `bun run lint`: passed (existing repository warnings remain).
- `bun run typecheck`: passed baseline gate; 2 existing errors versus baseline 116, no new errors; Cargo check passed.
- `openspec validate add-optional-tgrep-content-search --strict`: passed.
- `git diff --check`: passed.
- Activation, diagnostic interpretation, limitations and smoke-test command documented in `openwiki/workflows/development.md`.

## 3. Primary content backend

- [x] 3.1 Select tgrep by default for content with FFF failure fallback and explicit rollback.
- [x] 3.2 Verify primary routing, failure recovery, cancellation and bounded results.
- [x] 3.3 Install the local pinned binary, document operation and run required gates.

## Primary backend validation results

- Targeted Vitest suite: 5 files, 33 tests passed, including real tgrep 1.0.5 primary routing, default and maximum result limits, fallback recovery, and stale-query rejection.
- Local executable verified at `~/.local/bin/tgrep`: `tgrep 1.0.5`.
- `bun run lint`: passed, with existing repository warnings.
- `bun run typecheck`: passed baseline gate (2 existing errors, no new errors); Cargo check passed.
- `openspec validate add-optional-tgrep-content-search --strict`: passed.
- `git diff --check`: passed.
- Primary selection, FFF rollback, failure fallback and known limitations documented in `openwiki/workflows/development.md`. Restart the runtime to load the new provider selection.

## 4. Remove FFF

- [x] 4.1 Replace FFF file search and provider composition; remove the dependency, shadow mode and native CI gate.
- [x] 4.2 Cover file ranking, refresh, tgrep errors and lifecycle; update operation docs and specs.
- [x] 4.3 Run targeted tests, lint, typecheck and strict OpenSpec validation.

## FFF removal validation results

- Targeted Vitest suite: 5 files, 39 tests passed, including the real tgrep 1.0.5 smoke test.
- `bun run lint`: passed, with existing repository warnings; Cargo Clippy passed.
- `bun run typecheck`: passed baseline gate (2 existing errors versus baseline 116, no new errors); Cargo check passed.
- `openspec validate add-optional-tgrep-content-search --strict`: passed.
- `git diff --check`: passed.
- No remaining references to the removed FFF package, provider, native gate or backend/shadow environment switches in runtime code, dependencies, CI or operational documentation.
