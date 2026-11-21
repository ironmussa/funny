# Tasks

## 1. Dependency and lint integration

- [x] 1.1 Record the current fork extraction, working-tree changes, focused fork test results, lint and typecheck baseline; verify unrelated modifications are identified and preserved.
- [x] 1.2 Verify the published gdp-ts package exports and peer requirements, pin the dependency in the appropriate manifests, and upgrade Oxlint compatibly; verify installation and core/plugin imports succeed.
- [x] 1.3 Compose the GDP preset with existing lint configuration, including narrow trusted proof paths and public-barrel proof import recognition; verify existing rules, plugins and ignores remain active.
- [x] 1.4 Add an expected-failure lint fixture harness for forged proofs through direct and public imports, unauthorized minting and exported provers, plus a valid fixture; wire it into verification and verify every invalid fixture fails for its intended rule.
- [x] 1.5 Document the trusted proof scope and lint commands in OpenWiki development guidance; verify documented paths and commands match the configured gate.

## 2. Ownership evidence and fork operation contract

- [x] 2.1 Add immutable actor/source snapshot types and the pure ownership proof checker with a private prover; verify unit tests cover matching ownership and rejection of another actor, and that retained input aliases cannot alter the checked snapshot.
- [x] 2.2 Change the fork command and callable to bind named actor/source values to the ownership proof, preserving the result contract and deriving port arguments only from checked values; verify existing use-case tests pass with proofs obtained through the real checker.
- [x] 2.3 Add a dedicated zero-diagnostic no-emit proof contract target with positive examples and expected errors for missing/wrong proofs, actor/source substitution, raw values and scope escape; wire it into typecheck and verify no baseline refresh is used.
- [x] 2.4 Export only intended checker/types through the module entry point and document the application-to-adapter trust boundary in OpenWiki; verify module-boundary fitness and the public-import lint fixtures pass.

## 3. HTTP integration and behavior preservation

- [x] 3.1 Integrate scoped naming and proof issuance into the shared fork handler while retaining owner middleware and using the loaded row without another fetch; verify both successful route variants retain their current HTTP responses and raw-body forwarding.
- [x] 3.2 Add or extend route tests for missing threads, another owner, view/steer sharees and failed proof issuance; verify denial returns the existing 404 and invokes no runner resolution, remote call, registration or routing-cache mutation.
- [x] 3.3 Run the existing fork route, use-case, adapter and runner-isolation suites; verify error mappings, signed identity, registration metadata, default-runner behavior and per-actor runner selection remain unchanged.
- [x] 3.4 Update OpenWiki thread-domain guidance with the fork evidence flow and its HTTP/gRPC limitations; verify it preserves owner-only fork policy and does not imply expanded steer access.

## 4. Integration validation

- [ ] 4.1 Run `bun run lint` and `bun run typecheck` including the dedicated lint/type contract gates; verify no new diagnostics are tolerated through baseline changes or broad suppressions.
- [x] 4.2 Review the final diff against this design and existing fork characterization tests; verify no proof is serialized, no unrelated edits are overwritten, and no client, database or runner protocol migration was introduced.

## Verification note

The GDP runtime suites (133 tests), proof lint fixtures, zero-diagnostic proof
target and architecture fitness checks pass. The Oxlint 1.86 upgrade exposes an
existing `react/purity` error at `packages/client/src/components/settings/TeamMembers.tsx:338`
(`new Date()` during render). Full lint remains blocked by that client issue;
no suppression or baseline change was added. Client changes are outside this pilot.
