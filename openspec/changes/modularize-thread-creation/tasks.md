# Tasks

## 1. Establish the compatibility baseline

- [x] 1.1 Inventory creation helper consumers and current `codebase-simplification` changes; record actual helper ownership and selected server test commands in design.md, verifying that planned extraction does not duplicate runtime task 8.4 or overwrite unrelated changes.
- [x] 1.2 Add or extend characterization tests for normal/idle creation, scratch/project normalization, existing permissive payload handling, error precedence, and payload extensions; verify they pass against the current handler before extraction.
- [x] 1.3 Characterize unavailable runners, remote errors, top-level/nested IDs, missing IDs, branch precedence, default-runner bypass, malformed responses, and resolver/registry/cache failures; verify route tests capture existing statuses, bodies, and effect ordering.

## 2. Introduce the domain and application boundary

- [x] 2.1 Add the pure immutable creation-target union and normalization Result, keeping legacy request representation at the boundary; verify unit tests cover conflicting scratch inputs and normalized output without loading server infrastructure.
- [x] 2.2 Add local identifier brands at trusted boundaries and the command/port contracts; verify typecheck rejects identifier interchange with the repository's supported type-test convention and confirm no new wire validation is introduced.
- [x] 2.3 Implement the creation use case using injected ports; verify fake-based tests cover both intents, no I/O after normalization failure, metadata precedence, default-runner bypass, and the remote/register/cache sequence including partial failures.
- [x] 2.4 Document port ownership and domain invariants beside the module API; verify documented entry points exist and the use case imports no concrete infrastructure or HTTP framework.

## 3. Integrate existing adapters and routes

- [x] 3.1 Implement resolution and remote-creation adapters over existing runner services and signed forwarding helpers; verify adapter tests cover requesting-user scope, no foreign-runner fallback, trusted actor identity, and normal/idle path selection.
- [x] 3.2 Implement registry/cache adapters and production composition, reusing the current repository setup; verify adapter tests preserve returned branch priority, nested IDs, registration metadata, and default-runner behavior.
- [x] 3.3 Wire both HTTP creation endpoints to the composed use case, keeping parsing and HTTP mapping at the route boundary; verify all characterization tests pass unchanged and other route consumers retain working helper imports.
- [x] 3.4 Update OpenWiki architecture and thread-domain documentation with the new creation flow and its server/runtime ownership; verify links resolve and no documentation claims full CQRS or a repository-wide migration.

## 4. Enforce and verify the pilot

- [x] 4.1 Extend architecture fitness tooling to forbid domain/application imports of Hono, Drizzle, gRPC, database modules, concrete server services, or infrastructure and enforce the public entry point with a composition exception; verify focused allowed/forbidden import fixtures and inclusion in `bun run lint`.
- [x] 4.2 Run affected route/use-case/adapter suites and existing runner-isolation, scratch-thread, signed-identity, and steer-delegation regressions; record commands and results, confirming no unrelated access behavior changed.
- [x] 4.3 Run `bun run lint` and `bun run typecheck`; resolve regressions caused by this change and record any independently established pre-existing failures explicitly.
- [x] 4.4 Review the final diff against the baseline and record pilot findings in design.md: HTTP contracts unchanged, domain/use case testable without infrastructure, routes free of creation orchestration, no schema/protocol changes, and no edits to unrelated work. Keep wider rollout as a separate proposal.
