## 0. Divergence audit (DONE — 2026-06-05; see design.md "Audit findings")

- [x] 0.1 Read all five ACP adapters side by side; divergence matrix produced (spawn, set-model, mode, fork path, permission model, MCP filter, per-update quirks)
- [x] 0.2 gemini's 1031 vs pi's 597 explained: ~75% is shared instrumentation (acp-timing logs, image diag, stderrTail) the generic process absorbs once; ~100 lines are genuine quirks (cli-arg model, --yolo, ensureTrustedFolder)
- [x] 0.3 Minimal `QuirkFlags` set defined (7 flags + 3 menu selectors); the only imperative bit (gemini trustedFolders) is a named in-core `prelaunch` selector, not manifest code; pi banner-strip is a regex-as-data
- [x] 0.4 Widening blast radius enumerated: 1 total `Record<AgentProvider>` (already has a function-with-default), 2 real switches (both have default/throw), ~11 `provider === 'literal'` string comparisons (inert under widening). Small, no runtime breaks.

## 1. Manifest contract (`packages/shared/src`)

- [ ] 1.1 Define `ProviderManifest` + `QuirkFlags` types in `provider-manifest.ts`
- [ ] 1.2 Author manifests for codex, gemini, pi, cursor, opencode (data only)
- [ ] 1.3 Build a `MANIFEST_REGISTRY` + `KNOWN_PROVIDER_IDS` typed const; derive `MODEL_REGISTRY` entries, `PROVIDER_LABELS`, `PROVIDER_DEFAULT_MODEL`, attachment limits from it
- [ ] 1.4 Widen `AgentProvider` to string-at-boundaries with `KNOWN_PROVIDER_IDS` for ergonomics; fix the call sites from 0.4
- [ ] 1.5 Shared build + model tests green

## 2. GenericACPProcess (`packages/core/src/agents`)

- [ ] 2.1 Create `generic-acp.ts` — hoist the shared ACP lifecycle from the adapters, parameterized by `ProviderManifest`
- [ ] 2.2 Create `quirks/` — the in-core menu of named translateUpdate behaviors selected by `QuirkFlags`
- [ ] 2.3 Wire model-select (`setModel.method` via `extMethod`/typed call), mode map (`setSessionMode`), fork-capability paths, builtin tools from the manifest
- [ ] 2.4 `process-factory.ts` — build `GenericACPProcess(manifest)` for any `kind: 'acp'` provider id

## 3. Migrate providers one at a time (parity-gated)

- [ ] 3.1 Migrate **opencode** first (newest, simplest, freshest tests) → run `opencode-acp.test.ts` against GenericACPProcess unchanged → delete `opencode-acp.ts` when green
- [ ] 3.2 Migrate **cursor** → `cursor-acp.test.ts` green → delete `cursor-acp.ts`
- [ ] 3.3 Migrate **pi** → `pi-acp.test.ts` green → delete `pi-acp.ts`
- [ ] 3.4 Migrate **codex** (preamble→Think quirk) → `codex-acp.test.ts` green → delete `codex-acp.ts`
- [ ] 3.5 Migrate **gemini** (heaviest) → `gemini-acp.test.ts` green → delete `gemini-acp.ts`
- [ ] 3.6 Collapse `pi-discover`/`cursor-discover`/`opencode-discover` into one manifest-driven discovery (identical `{ ok, models, currentModelId }` contract)

## 4. Runtime (`packages/runtime/src`)

- [ ] 4.1 `acp-fork.ts` — derive provider set + fork-capability paths from manifests
- [ ] 4.2 `app/system-routes.ts` — one generic `/api/system/:provider/models` route driven by manifest discovery; remove per-provider routes (keep old paths as aliases for one release)
- [ ] 4.3 `validation/schemas.ts` — provider enum + model schema from the manifest registry
- [ ] 4.4 `utils/provider-detection.ts` — manifest-driven availability
- [ ] 4.5 Runtime build + runtime test suite green

## 5. Client (`packages/client/src`)

- [ ] 5.1 Collapse `pi-models-store`/`cursor-models-store`/`opencode-models-store` into one manifest-parameterized store
- [ ] 5.2 Collapse the three `use-*-prompt-models` hooks into one; unified picker iterates manifests
- [ ] 5.3 `GeneralSettings.tsx` — derive provider/model UI from manifests
- [ ] 5.4 Client build + client tests green

## 6. Verification

- [ ] 6.1 All five ACP adapter test suites pass unchanged against `GenericACPProcess`
- [ ] 6.2 `process-factory.test.ts` + `acp-fork.test.ts` green for every manifest provider
- [ ] 6.3 Full type-check (`bunx tsc --noEmit`) clean; full build green
- [ ] 6.4 Manual: each migrated provider runs a thread end-to-end (parity smoke vs current behavior)
- [ ] 6.5 Confirm net LOC deleted (target: ~3,000 lines) and "add a provider" reduced to a single manifest

## 7. Phase B — external loader (DESIGNED here, OUT of v1 implementation)

- [ ] 7.1 (future change) `funny.provider` JSON manifest discovered from `<DATA_DIR>/extensions` like visualizers
- [ ] 7.2 (future change) declarative-only enforcement + install-time disclosure ("launches <command> on your runner")
- [ ] 7.3 (future change) lean-core default-bundle toggle
