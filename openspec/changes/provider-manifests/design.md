## Context

funny runs five ACP-based agent backends (codex, gemini, pi, cursor, opencode) through five near-identical `BaseAgentProcess` subclasses, plus Claude (SDK), DeepAgent, and llm-api. Each ACP adapter independently spawns a CLI over stdio, opens a JSON-RPC `ClientSideConnection`, and translates ACP `sessionUpdate` notifications into funny's `CLIMessage` stream. The `opencode-provider` change demonstrated that adding one provider is a multi-package, mostly-copy-paste edit, because each provider is hardcoded in: the `AgentProvider` union (`shared/primitives.ts`), `MODEL_REGISTRY` (`shared/models.ts`), `agentProviderSchema` (`runtime/validation/schemas.ts`), `ACP_PROVIDERS` (`runtime/.../fork.ts`), `acp-fork.ts`'s `resolveAcpCommand`, the per-provider `/system/:p/models` routes, and the per-provider client store/hook.

A runtime registration seam already exists (`registerProvider()` + `providerRegistry` fallback in `process-factory.ts`) — this change makes the whole stack lean on a manifest instead of hardcoding.

## Goals / Non-Goals

**Goals (Phase A, v1)**

- One `GenericACPProcess` + N declarative manifests replace the five ACP adapters with **zero behavior change** (existing ACP tests pass unchanged).
- Adding an ACP provider = authoring a manifest (~30 lines), not editing ~20 files.
- All cross-cutting layers (type registry, model catalog, zod, fork, client picker, discovery, detection) derive from the manifest set.

**Goals (Phase B, designed not built)**

- A forward-compatible, **declarative-JSON-only** manifest the runner can load from disk like a visualizer extension.
- A defensible trust boundary and a "lean core" packaging story.

**Non-Goals**

- No arbitrary-code harness extensions (would need sandboxing — explicitly deferred).
- No change to the Claude SDK / DeepAgent / llm-api adapters in v1 (they aren't ACP; they can adopt a manifest later).
- No new providers in this change — it is a refactor of the existing set.

## Decisions

### Decision 1: The manifest is data; quirks are a fixed in-core menu (not code)

The manifest is pure data. The genuinely provider-specific behaviors in `translateUpdate` (codex buffers "preamble" tool_calls into a Think card; cursor/opencode defer un-renderable tool inputs; gemini's longer divergences) are expressed as **named quirk flags** that select from a fixed menu of behaviors **implemented in core**:

```ts
interface ProviderManifest {
  id: string; // 'opencode'
  label: string; // 'opencode'
  kind: 'acp'; // v1 covers ACP; sdk/llm-api later
  spawn: {
    command: string; // 'opencode'
    args: string[]; // ['acp']
    binEnvVars: string[]; // ['OPENCODE_BIN', 'ACP_OPENCODE_BIN']
    npxSpec?: { useEnvVar: string; pkg: string[] }; // OPENCODE_ACP_USE_NPX → ['-y','opencode-ai','acp']
  };
  models: { kind: 'static'; entries: ModelDefinition[] } | { kind: 'dynamic' }; // discover via session/new models.availableModels
  setModel?: { method: 'session/set_model' | 'unstable_setSessionModel' }; // omit = no model select
  modeMap: Record<PermissionMode, string | null>; // funny mode → provider session mode id
  forkCapabilityPaths: string[]; // ['sessions.fork', 'sessionCapabilities.fork']
  builtinTools: string[]; // cosmetic init-card list
  auth: { mode: 'runner-preauth' | 'provider-key'; providerKey?: ProviderKeyConfig };
  quirks: QuirkFlags; // { bufferPreambleAsThink?, deferUnrenderableToolInput?, ... }
}
```

- **Why a menu, not hooks:** an external manifest must never carry executable code (Decision 4). A fixed menu keeps every behavior vetted and in-tree; a provider needing a behavior not in the menu is a small core PR that adds a flag — rare and reviewable. This is the crux that makes Phase B safe.
- **Risk to validate (task 1):** audit each of the five adapters and enumerate the _complete_ set of real divergences. If one adapter has logic that resists a flag, that flag's behavior still lives in core — the manifest just can't be authored externally for it until the flag exists.

### Decision 2: `GenericACPProcess` owns the shared skeleton

The shared lifecycle — spawn, `initialize`, `loadSession`/`newSession`, `emitInit`, `setSessionMode`, model select, the `prompt` turn loop, `sendPrompt`/steer, permission pause, `translateUpdate` switch, deferred-tool-input buffering, usage — moves into `GenericACPProcess`, parameterized by the manifest. The per-provider quirk flags toggle the small branches. This is a mechanical hoist of code that is already duplicated five times.

### Decision 3: The manifest set is the single source of truth for every layer

Instead of hand-editing seven places per provider, each layer derives from the manifest registry:

- `AgentProvider` → `string` at boundaries + a `KNOWN_PROVIDERS` set built from manifests (keeps autocomplete/exhaustiveness where it helps, loses the compile-time wall that forces 10-file edits).
- `MODEL_REGISTRY` entries, `PROVIDER_LABELS`, `PROVIDER_DEFAULT_MODEL`, attachment limits → generated from manifests.
- `agentProviderSchema` → `z.string()` refined against the live manifest registry (dynamic providers already use `z.string().min(1)`).
- `ACP_PROVIDERS` / `acp-fork` command + capability paths → from manifests.
- Client picker groups, discovery store, settings → iterate manifests.

**Trade-off:** widening `AgentProvider` from a literal union to `string` loses some compile-time exhaustiveness. Mitigation: keep a `KNOWN_PROVIDER_IDS` const union for the bundled set (typed ergonomics where it matters) while the runtime registry accepts any id. This is the same pattern the model side already uses (pi/cursor/opencode pass dynamic model ids as strings).

### Decision 4: Phase B trust boundary — declarative JSON only, no code

External provider extensions (Phase B) ship a **JSON manifest**, not JavaScript. The manifest can declare a binary to spawn, args, env-var names, and ACP protocol params + quirk-flag selections **from the in-core menu**. It cannot define new behavior.

- **Threat model:** the worst an external manifest can do is point funny at a binary on the runner's PATH with chosen args — something the runner's operator can already do directly. Quirk behaviors are all pre-vetted core code. This is strictly weaker than the visualizer extension model (which dynamically `import()`s third-party JS into the browser), and far weaker than "load a JS harness into the runner" (rejected).
- **Still enforced:** the runner is not sandboxed (per CLAUDE.md), so even a binary-spawn manifest is only as safe as the binary. Install flow reuses the visualizer loader's guardrails (realpath, no symlink escape, whitelisted git URLs, never run the package's build). A clear install-time disclosure states "this lets funny launch <command> on your runner."
- **Explicitly deferred:** manifests that carry executable transform code, custom non-ACP protocols, or in-process SDK providers. Those need a real sandbox and are a separate proposal.

### Decision 5: Lean core via bundled manifests

"Don't ship every provider by default" becomes: built-ins are themselves manifests, and the default bundle can include as few as desired (e.g. claude + codex). The rest install as Phase-B extensions. v1 keeps all current built-ins bundled (no regression); the lean-default toggle is a packaging decision enabled by, but not forced by, this change.

## Risks / Trade-offs

- **Hidden adapter divergence** (highest risk). gemini-acp is 1031 lines — some of that may be real logic, not data. _Mitigation:_ task 1 is a line-by-line divergence audit producing the definitive `QuirkFlags` set before any deletion. If a divergence won't reduce to a flag, it stays as a core quirk behavior (still fine for built-ins; just not externally authorable yet).
- **Loss of compile-time provider exhaustiveness.** _Mitigation:_ `KNOWN_PROVIDER_IDS` typed const for bundled providers; runtime registry for the rest.
- **Big refactor, regression surface.** _Mitigation:_ the existing per-provider ACP tests (`codex-acp.test.ts`, `cursor-acp.test.ts`, `opencode-acp.test.ts`, `pi-acp.test.ts`, `acp-fork.test.ts`, `process-factory.test.ts`) are the safety net — they must pass unchanged against `GenericACPProcess`, re-pointed at the manifest. Migrate one provider at a time behind the registry.
- **Discovery/route consolidation.** Collapsing three discover modules + three routes into one is mechanical but touches the client stores. _Mitigation:_ keep the response contract identical (`{ ok, models, currentModelId }`) so the client change is just parameterization.

## Migration Plan

Phase A is internal and incremental: introduce `GenericACPProcess` + manifests alongside the existing adapters, migrate providers one at a time (register the manifest-built process for that id, run its test suite), then delete the old adapter once green. No DB migration, no protocol bump, no API shape change. Rollback at any point = re-register the old adapter class for that id. Phase B is a separate future change that adds the disk loader on top of the finished manifest contract.

## Audit findings (Phase 0, resolved 2026-06-05)

Full read of all five adapters confirms the "it's all data" thesis. The definitive contract:

**`QuirkFlags` (the complete minimal set):**

```ts
interface QuirkFlags {
  bufferPreambleAsThink?: boolean; // codex, gemini
  planRender?: 'text' | 'todoCard'; // text: codex/gemini/pi · card: cursor/opencode
  deferUnrenderableToolInput?: boolean; // cursor, opencode
  synthToolUseFromOrphanUpdate?: boolean; // gemini, cursor, opencode
  stripFirstMessageBanner?: string; // pi — regex-as-DATA, applied in core (ReDoS-guard in Phase B)
  permissionModel?: 'gated' | 'auto-allow'; // pi = auto-allow (no permission gating at all)
  filterMcpByCapability?: boolean; // pi, cursor, opencode
}
```

**Menu selectors (closed enums in core, not booleans):**

```ts
modelVia?:  'acp-method' | 'cli-arg';            // gemini = cli-arg (--model)
modeVia?:   'acp-setSessionMode' | 'cli-flag';   // gemini = cli-flag (--yolo)
prelaunch?: 'gemini-trust-folder';               // the ONLY imperative bit (writes ~/.gemini/trustedFolders.json)
setModel?:  { method: 'session/set_model' | 'unstable_setSessionModel' } // codex/pi/cursor vs opencode
```

Note: `thought→Think` is **universal** (all five) → it's base behavior, not a quirk. opencode's effort-suffix and codex's `model/effort` fusion are both covered by the existing model-id passthrough.

**Why gemini is 1031 lines (vs pi's 597):** ~150 lines of verbose `acp-timing`/image/error diagnostics + ~30 lines of `stderrTail` buffer are **shared instrumentation** the generic process absorbs once; ~750 lines are the **identical skeleton**; only ~100 lines (`ensureTrustedFolder`, `--yolo`/`--model` arg building) are genuine quirks. The bloat is not logic — it is duplicated instrumentation.

**Widening blast radius (`AgentProvider → string`):** SMALL.

- 1 total `Record<AgentProvider, …>` (`PROVIDER_ATTACHMENT_LIMITS`) — already wrapped by `getAttachmentLimits(p)` with a `?? claude` default, so safe.
- 2 real `switch(provider)` (`llm/model-factory.ts`, `acp-fork.ts`) — both have `default`/throw; acp-fork becomes manifest-derived anyway.
- ~11 files with `provider === 'literal'` — plain string comparisons, **inert under widening** (lose exhaustiveness lint, zero runtime breaks).

**Residual risk:** pi's banner-strip regex, if ever supplied by an _external_ manifest, is a ReDoS vector → validate + timeout in Phase B. Does not affect Phase A (built-in regex is trusted).

## Open Questions (remaining)

1. ~~Divergence audit~~ — **resolved above.**
2. ~~Widening blast radius~~ — **resolved above (small).**
3. **Built-in manifests location:** `shared` (so client + runtime + server all read them) vs `core`? Leaning `shared` since the client picker and zod schema both need them.
4. **Phase B scope split:** does the loader ship declarative-ACP-only first, or also a curated registry/marketplace? (Likely loader-first, registry later.)
5. **llm-api / Claude SDK:** do they eventually become manifests too (`kind: 'sdk' | 'llm-api'`), or stay bespoke? (v1: stay bespoke; revisit after ACP proves the model.)
