## Why

Arcs currently only distinguish between two phases (`explore` and `implement`), but the conceptual workflow has three: Explore, Plan, and Implement. The "Plan" phase is implicit — users either do it manually within explore or skip it entirely. This leads to agents jumping from open-ended exploration directly into code execution without a structured planning step that validates feasibility, defines architecture, and produces a prioritized task breakdown. Adding a dedicated Plan agent closes this gap and produces higher-quality arc artifacts before implementation begins.

## What Changes

- Add `'plan'` to the `ThreadPurpose` type (`'explore' | 'plan' | 'implement'`)
- Create a new `getPlanPrompt(arcName)` function in `arc-prompts.ts` with a planning-focused system prompt
- Update `NewThreadDialog` to show three purpose options (Explore / Plan / Implement) when an arc is selected
- Force `plan` threads to use `local` mode (same as explore — no worktree needed since planning doesn't write application code)
- Refine existing explore and implement prompts to better delineate their roles now that plan exists as a separate phase

## Capabilities

### New Capabilities

- `plan-agent`: The new Plan phase agent — system prompt, thread purpose handling, and UI integration for the planning role within arcs

### Modified Capabilities

## Impact

- **`packages/shared/src/types.ts`** — `ThreadPurpose` type gains `'plan'` value
- **`packages/runtime/src/services/arc-prompts.ts`** — New `getPlanPrompt()` function, minor refinements to existing prompts
- **`packages/client/src/components/NewThreadDialog.tsx`** — Third option in purpose selector, local-mode enforcement for plan threads
- **`packages/runtime/src/services/agent-runner.ts`** — Handle `'plan'` purpose when injecting arc system prompts (same pattern as explore/implement)
- No database migration needed — `purpose` column is already a `TEXT` field, no enum constraint
- No breaking changes — existing `'explore'` and `'implement'` threads continue to work unchanged
