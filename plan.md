# Plan: Add Slice Descriptions + Per-Package evflow Models with Central Composition

## Goal

Split the monolithic `packages/shared/src/evflow.model.ts` so each package defines its own slices locally, add `description` to slices, then compose them all from a central entry point.

## Changes

### 1. Add `description` field to `SliceDef` and `SliceOptions` (evflow DSL)

**File: `packages/evflow/src/types.ts`**
- Add `description?: string` to `SliceDef` (line 223)
- Add `description?: string` to `SliceOptions` (line 235)

**File: `packages/evflow/src/event-model.ts`**
- Pass `opts.description` through in the `slice()` method (line 214)

**File: `packages/evflow/src/generators/ai-prompt.ts`**
- Render `slice.description` in AI prompt output (after `### ${slice.name}`, line 214)

**File: `packages/evflow/src/generators/react-flow.ts`**
- Include `description` in slice group node data (line 142-158)

### 2. Add `merge()` method to `EventModel` for composing models

**File: `packages/evflow/src/event-model.ts`**
- Add `merge(other: EventModel): void` — imports all elements, sequences, slices, and contexts from another EventModel into this one. This is the key enabler: each package builds its own `EventModel`, then the central file merges them.

### 3. Split model into per-package files

**New file: `packages/runtime/src/evflow.model.ts`**
- Move the 4 runtime-owned slices here: Thread Management, Git Operations, Pipeline, Terminal Management
- Move the Watcher Lifecycle slice here (runtime owns the watcher service)
- Export `createRuntimeModel(): EventModel`

**New file: `packages/server/src/evflow.model.ts`**
- For now, this is a placeholder since the current model doesn't define server-specific slices yet
- Export `createServerModel(): EventModel`
- The server could later add slices for: Runner Coordination, Authentication, Data Proxying

**New file: `packages/client/src/evflow.model.ts`**
- For now, placeholder — the client could later define UI-specific slices (read model mappings)
- Export `createClientModel(): EventModel`

### 4. Update central composition file

**File: `packages/shared/src/evflow.model.ts`** (refactor existing)
- Import `createRuntimeModel` from `@funny/runtime`
- Import `createServerModel` from `@funny/server` (when it exists)
- Merge all sub-models into one using `system.merge(runtimeModel)`
- Export the composed `EventModel`
- This becomes the single source of truth that shows how everything connects

**Wait — circular dependency problem!** `shared` can't import from `runtime` or `server` (shared is a dependency OF those packages, not the other way around).

**Revised approach:** The composition file lives at the **workspace root** or as a **standalone script**, not in `packages/shared`. The per-package models are self-contained. The composition is done by whoever needs the full picture (e.g., viewer, docs generation, tests).

### Revised file structure:

```
packages/runtime/src/evflow.model.ts    → runtime slices (Thread, Git, Terminal, Pipeline, Watcher)
packages/server/src/evflow.model.ts     → server slices (placeholder for now)
packages/client/src/evflow.model.ts     → client slices (placeholder for now)
packages/shared/src/evflow.model.ts     → COMPOSED model that imports from runtime (+ add slice descriptions)
```

**But shared→runtime is still circular.** Better option:

```
packages/runtime/src/evflow.model.ts    → all current slices (runtime owns the domain model)
packages/shared/src/evflow.model.ts     → re-exports from runtime OR deleted
```

Actually, the simplest correct approach given the dependency graph (`shared ← runtime ← server`):

1. **Keep the model in `packages/shared/src/evflow.model.ts`** — it's the right place since all packages depend on shared
2. **Add slice descriptions** — enrich each `system.slice()` call with a description
3. **Add a `sliceDescriptions()` convenience method** on EventModel that returns just the slice names + descriptions for a quick overview
4. **Create `evflow.model.ts` files in runtime/server/client** that import and reference the shared model for their own documentation

Actually, re-reading your request more carefully: you want each slice's **full definition** to live in the package that owns it. The simplest way:

### Final approach:

1. **Add `description` to slices** (evflow DSL change)
2. **Add `merge()` to EventModel** (composition primitive)
3. **Move runtime slices to `packages/runtime/src/evflow.model.ts`**
4. **Keep `packages/shared/src/evflow.model.ts` as the composer** — BUT reverse the import: shared doesn't import runtime. Instead, the **composition happens in runtime** (which already depends on shared):
   - `packages/runtime/src/evflow.model.ts` — defines runtime slices AND exports the full composed model
   - `packages/shared/src/evflow.model.ts` — deleted (or becomes just types)

**Or even better:** Create a new top-level script that does the composition:

```
evflow.model.ts (workspace root)         → imports from all packages, composes full model
packages/runtime/src/evflow.model.ts     → runtime slices only
packages/server/src/evflow.model.ts      → server slices only (future)
```

### Summary of changes:

| # | File | Change |
|---|------|--------|
| 1 | `packages/evflow/src/types.ts` | Add `description?: string` to `SliceDef` and `SliceOptions` |
| 2 | `packages/evflow/src/event-model.ts` | Pass `description` through in `slice()`, add `merge(other)` method |
| 3 | `packages/evflow/src/generators/ai-prompt.ts` | Render slice descriptions |
| 4 | `packages/evflow/src/generators/react-flow.ts` | Include slice description in group node data |
| 5 | `packages/evflow/src/__tests__/event-model.test.ts` | Add test for slice description, add test for merge() |
| 6 | `packages/runtime/src/evflow.model.ts` | Move all current slices here (Thread, Git, Terminal, Pipeline, Watcher) with descriptions |
| 7 | `packages/shared/src/evflow.model.ts` | Becomes a thin composer: imports runtime model, merges, exports |
| 8 | `packages/evflow/viewer/gen-json.ts` | Update import path if needed |

Wait — step 7 still has the circular dep. Let me finalize:

**`packages/shared` depends on `@funny/evflow`** ✓
**`packages/runtime` depends on `@funny/shared`** ✓
**`packages/shared` CANNOT depend on `@funny/runtime`** ✗

So the composed model **must** live in runtime or higher. The current file IS in shared, so let's keep it there but understand that it can only use evflow (no runtime imports). That's fine — the model is pure DSL, no runtime imports needed.

### Final final approach (simplest, no circular deps):

1. **evflow DSL changes** — add `description` to slices, add `merge()` to EventModel
2. **`packages/runtime/src/evflow.model.ts`** — defines runtime slices (Thread Management, Git Operations, Terminal Management, Pipeline, Watcher Lifecycle) with descriptions. Exports `createRuntimeModel()`.
3. **`packages/shared/src/evflow.model.ts`** — imports `createRuntimeModel()` from... wait, shared can't import from runtime.

**OK, the real answer:** The evflow model is **pure domain specification** (no runtime code). It belongs wherever makes sense. Since `shared` is the lowest package, the model stays there. Each package doesn't need its own model file — the model describes the **system** not individual packages.

**What you actually want is:** Add descriptions to slices so you can see at a glance what each vertical feature cut does, and have those descriptions accessible from the package root.

### FINAL PLAN:

1. **Add `description` to SliceDef/SliceOptions** in evflow DSL
2. **Add descriptions to all 5 slices** in `packages/shared/src/evflow.model.ts`
3. **Add `merge()` to EventModel** for future composition
4. **Update generators** (ai-prompt, react-flow) to render slice descriptions
5. **Update tests**
