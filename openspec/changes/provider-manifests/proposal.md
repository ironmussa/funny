## Why

Adding a single agent provider today is a ~20-file edit across all five packages, and the result is mostly **copy-paste**. The `opencode-provider` change (just shipped) proved it: `opencode-acp.ts` is a near-verbatim clone of `cursor-acp.ts`. The five ACP adapters total ~3,900 lines and are ~90% identical — their real differences are **data**, not logic:

```
gemini-acp.ts 1031 ┐   • binary + args + env-override var names
cursor-acp.ts  901 │   • model-select method (session/set_model vs unstable_setSessionModel)
codex-acp.ts   763 ├─▶ • permission/session mode map (build/plan vs read-only/auto/full-access)
opencode-acp.ts~640│   • fork-capability path (sessions.fork vs sessionCapabilities.fork)
pi-acp.ts      597 ┘   • builtin tool list (cosmetic) + 2-3 translateUpdate quirks
```

That data shape is a **manifest**. Today we express it by cloning 700 lines; it should be ~30 lines of declaration. The same hardcoding shows up in the shared type union (`AgentProvider`), the model registry, the zod schemas, the fork allow-list, and the client picker — every new provider touches all of them.

The user's goal: stop shipping **every provider baked in by default** ("para no tener todas las opciones por defecto") and instead make providers/harnesses **installable**, like funny's existing visualization extensions (`server/src/lib/extensions.ts`). That end-state (lean core + installable providers) is only feasible once a provider is expressible as data. **This change creates that contract.**

## What Changes

This proposal covers the full arc but scopes **v1 implementation to Phase A** (the in-tree manifest system). Phase B (external loading) is fully **designed** here so the manifest is forward-compatible, but its loader is a follow-on change.

**Phase A — manifest-driven providers (v1, implemented):**

- Introduce a declarative **`ProviderManifest`** type (pure data) that captures everything that differs between ACP adapters: spawn command/args/env, model-select method, mode map, fork-capability paths, builtin tools, model-discovery strategy, auth mode, and a fixed menu of **quirk flags** for the handful of genuine `translateUpdate` divergences.
- Introduce a single **`GenericACPProcess`** that reads a `ProviderManifest` and replaces `codex-acp.ts`, `gemini-acp.ts`, `pi-acp.ts`, `cursor-acp.ts`, and `opencode-acp.ts`.
- Migrate all five providers to manifests; delete the per-provider adapter files once parity is proven by the existing ACP tests.
- Derive the **`AgentProvider` registry, model registry entries, zod schema, fork allow-list, and client picker groups from the manifest set** instead of hand-maintaining each. Widen the static `AgentProvider` union to `string` at the boundaries (keeping a typed set of known ids) so the registry is the single source of truth — the `registerProvider()` seam in `process-factory.ts` already points this way.

**Phase B — external provider extensions (designed here, built later):**

- Specify a **declarative-JSON-only** manifest that funny can discover from `<DATA_DIR>/extensions` via a `funny.provider` package.json field, mirroring the visualizer loader. **No executable code** crosses the boundary — a manifest can only declare "spawn this already-installed binary and speak ACP with these params", which is bounded to what a runner operator could already do. Arbitrary-code harnesses are explicitly **out of scope** (would require real sandboxing).
- Specify a **lean-core** mode: built-ins become bundled manifests, so "ship fewer providers by default" is a packaging choice, not an architecture change.

## Capabilities

### New Capabilities

- `provider-manifests`: Agent providers are defined by declarative manifests consumed by a single generic ACP runtime, and every layer (type registry, model catalog, validation, fork, client picker) derives from the manifest set rather than per-provider hardcoding.

### Modified Capabilities

- `opencode-provider` (and the other four ACP providers, which have no standalone spec): re-expressed as manifests. Behavior is preserved; the implementation is unified. No user-facing change.

## Impact

**Shared (`packages/shared/src`)**

- New `provider-manifest.ts` — the `ProviderManifest` type + the bundled built-in manifests (or a manifest registry).
- `primitives.ts` / `models.ts` / `runtime/validation/schemas.ts` — derive `AgentProvider`, `MODEL_REGISTRY` entries, labels, defaults, and the zod provider enum from the manifest set; widen to string at boundaries.

**Core (`packages/core/src/agents`)**

- New `generic-acp.ts` (`GenericACPProcess`) + a `quirks/` menu of named, in-core translateUpdate behaviors.
- Delete `codex-acp.ts`, `gemini-acp.ts`, `pi-acp.ts`, `cursor-acp.ts`, `opencode-acp.ts` after migration; `process-factory.ts` builds `GenericACPProcess` from the manifest.
- `acp-fork.ts` — derive the ACP provider set + fork-capability paths from manifests.
- `*-discover.ts` — collapse `pi-discover`/`cursor-discover`/`opencode-discover` into one manifest-driven discovery (`session/new` model probe).

**Runtime (`packages/runtime/src`)**

- `app/system-routes.ts` — one generic `/api/system/:provider/models` route driven by manifest discovery, replacing the per-provider routes.
- `utils/provider-detection.ts` — manifest-driven availability.

**Client (`packages/client/src`)**

- Collapse `pi-models-store`/`cursor-models-store`/`opencode-models-store` and their hooks into one manifest-parameterized store + hook; the unified picker iterates manifests.
- `GeneralSettings.tsx` — provider/model UI derives from manifests.

**No DB migration. No protocol change. No user-facing behavior change in Phase A** — it is a structural refactor whose correctness is pinned by the existing ACP adapter tests (which must pass unchanged against `GenericACPProcess`).
