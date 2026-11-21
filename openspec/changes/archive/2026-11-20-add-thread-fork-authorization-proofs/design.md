# Design

## Context

See proposal.md for motivation. The current fork extraction shares one application use case between two routes. `ForkThreadCommand` contains an `ActorContext` and a `ForkSource` with a branded ID; `authorizedThreadId` is a cast, not evidence linking the actor to the source. The owner middleware loads the thread once and the route forwards its raw body. Existing route and adapter tests characterize errors, registration, signed identity and runner selection.

The module boundary check forbids Hono, DB and concrete services in domain/application. The root typecheck uses an error baseline. Root Oxlint is currently 1.81.0; the inspected upstream gdp-ts manifest declares Oxlint >=1.86. Dependencies and compatibility must be verified against the actual published package during implementation.

## Goals / Non-Goals

**Goals:** Make ownership a required, value-specific contract for direct fork callers, preserve the existing HTTP and runner behavior, and demonstrate that both the compiler and linter reject representative mistakes.

**Non-Goals:** Migrate other operations, change RBAC, replace authentication, serialize proofs, change scratch-fork behavior, make remote fork and registration atomic, or claim protection against arbitrary untyped callers.

## Decisions

### D1. Bind the complete actor and source snapshots

Use scoped `Named<U, Readonly<ActorContext>>` and `Named<T, Readonly<OwnershipForkSource>>` values. The source snapshot contains branded thread ID, project ID and owner ID from the middleware-loaded row. The command also requires `ThreadOwnedBy<U, T>`. The operation derives every actor/source value from these named snapshots; there must be no independently supplied user ID, thread ID, or project ID that could disagree with the checked values.

Create fresh, shallow-frozen snapshots before naming them. All security-relevant fields are primitive and readonly. This avoids checking an object that a retained alias can mutate before use. A small domain helper in `domain/proofs/thread-owned-by.ts` compares source owner ID and actor user ID, returning a proof or null. Keep its `defineProof` result private. Export the checker and proof interface through the module entry point.

Alternative: add a proof next to the unchanged command. Rejected because the command could still carry an unrelated actor or source. A generic `AuthorizedThreadId` brand is also insufficient: it records neither the actor nor the particular authorization kind.

### D2. Preserve middleware and scope proof issuance to the route operation

Keep `requireThreadOwner` on both routes. Inside the shared fork handler, build immutable snapshots from the session and loaded thread, call `name`, invoke the shared domain proof helper, and run the use case inside that callback. A null proof returns the existing `404 Thread not found` before runner resolution or mutation. The proof check is only a repeated in-memory equality comparison; do not fetch the thread again. Keep existing body-reading/error ordering unless needed to ensure no side effects precede the proof check.

The existing spec explicitly forbids a second ownership check, so the delta permits this narrowly scoped proof step while preserving centralized policy and middleware authorization. It does not permit ad hoc route policy implementations.

Alternative: store proofs in Hono context. Rejected because erasing the scoped names with `any`/`unknown` undermines the contract. Replacing all access middleware with callback APIs is deferred to avoid a repository-wide migration.

### D3. Protect the application boundary and retain trusted transport adapters

Make the returned `ForkThread` callable generic in the two names, require the proof in its command, and unwrap values only inside the use case when invoking existing ports. Domain/application stays independent of Hono and infrastructure. Keep the existing `neverthrow` result and failure mapping.

Adapters are trusted implementation details, not separately proof-gated public APIs. The pilot protects calls to this use case, not every possible direct database or transport call. Preserve module import restrictions. Proofs never enter HTTP bodies, signed identity, gRPC messages, registries or routing caches. Runtime validation and signed-identity verification continue unchanged.

### D4. Integrate lint with public module exports

Add a pinned published `@gdp-ts/core` dependency to the server and make the lint plugin resolvable from the root configuration. Upgrade Oxlint to a verified compatible version, preserving existing rules, JS plugins, ignores and overrides. Prefer composing the shipped preset in `oxlint.config.ts`; verify CLI and scripts use the new configuration and remove the superseded config only as part of that migration.

Use a narrow trusted-module glob for this proof module. Configure `proofImports` to recognize proof types imported through the threads public entry point as well as direct proof paths. Test this with the actual plugin: do not assume re-export tracking works. Keep basic proof rules broadly enabled; apply strict no-assertion/no-any rules to the proof-consuming use case and new protected code where feasible. Existing transport casts stay outside the proof boundary. Legitimate branded-ID constructors get explicit, narrow exceptions if strict scope reaches them.

Lint fixtures must exercise casts through the public barrel, direct proof casts, unauthorized proof construction and exported provers. Invalid fixtures must be linted by a dedicated expected-failure harness rather than becoming permanent failures in ordinary lint. Integrate that harness into the verification gate.

### D5. Verify the safety property independently of the existing baseline

Add a dedicated no-emit typecheck target for proof contracts with zero tolerated diagnostics. Include positive calls and `@ts-expect-error` cases for missing proof, wrong actor, wrong source, wrong proof kind, raw values and attempts to return a proof from its naming scope. Keep these files out of runtime test discovery. Wire the target into normal typecheck without refreshing the existing baseline.

Exercise the real pure checker with test snapshots; do not export a test-only prover or cast fake proofs. Preserve the existing fork use-case tests by creating valid proofs through that checker. Route tests cover both variants, owner success, non-owner/shared-user rejection, missing threads, and no runner side effects on denial. Retain the existing cross-user runner-resolution coverage and response characterization.

## Risks / Trade-offs

- TypeScript assertions and `any` can bypass the contract → tested lint enforcement and a small reviewed trusted proof module; no claim of runtime capability security.
- Ownership can change after checking → request-local use, immutable snapshots and unchanged runtime checks; this change does not solve database races or remote atomicity.
- Global Oxlint upgrade can surface unrelated diagnostics → characterize the current gate first, inspect upgrade effects and avoid broad suppressions or unrelated cleanup.
- A barrel import may evade syntactic lint recognition → explicit import patterns and negative fixtures using production import paths are required acceptance checks.
- Existing fork files have working-tree changes → implement on the current extraction and preserve unrelated edits.
- Older RBAC artifacts contain policies differing from live code → retain current owner-only fork behavior; do not reinterpret role inheritance during this pilot.

## Migration Plan

1. Record existing fork behavior and verification baseline; verify the published dependency and compatible tooling.
2. Add proof contracts and their focused type/lint checks, then update the use case and both HTTP callers together.
3. Run the proof checks, focused runtime suites, required lint and typecheck; document the pattern in OpenWiki.
4. No database migration or runner release is required. Roll back by reverting this change's code/config/dependency edits together, retaining the pre-existing fork extraction and unrelated work.

## References

- https://github.com/rauchg/gdp-ts/blob/main/src/index.ts
- https://github.com/rauchg/gdp-ts/blob/main/src/lint/shared.ts
- https://github.com/rauchg/gdp-ts/blob/main/package.json
- https://github.com/rauchg/gdp-ts/blob/main/skills/gdp-ts/references/limits.md
- ../modularize-thread-fork/design.md
