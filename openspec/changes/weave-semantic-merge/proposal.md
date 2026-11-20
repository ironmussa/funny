# Weave Semantic Merge Integration

## Problem

When multiple agents work in parallel on the same repo via worktrees, merging their branches back into the base branch frequently produces false conflicts. Git's line-based merge sees two agents touching the same file — even adding completely independent functions — and flags it as a conflict. The user must manually resolve these non-conflicts or ask the agent to fix them, breaking the parallel workflow.

This is especially painful because Funny's merge flow rebases the feature branch onto the target before merging (`git rebase targetBranch`). The rebase is where most false conflicts surface, aborting the entire merge and forcing manual intervention.

## Solution

Integrate [Weave](https://github.com/Ataraxy-Labs/weave), an entity-level semantic merge driver that uses tree-sitter to parse code into semantic entities (functions, classes, JSON keys, imports) and merges at that level instead of line-by-line.

When Weave is installed on the system, Funny automatically configures it as the git merge driver for supported file types. No changes to the merge flow itself — Git invokes Weave transparently during both `rebase` and `merge --no-ff` operations. Merges that previously failed with false conflicts now silently succeed.

**How Weave works:**

1. Parses base/ours/theirs into semantic entities via tree-sitter
2. Matches entities by identity (`file:type:name:parent`)
3. Auto-resolves independent changes (different functions in same file)
4. Falls back to line-level merge for truly overlapping edits, binary files, or unsupported types

## Key Decisions

- **Transparent integration**: No changes to `mergeBranch()` or the merge UI. Weave is configured as a git merge driver and Git invokes it automatically.
- **Local config only**: Uses `.git/config` (local) and `.git/info/attributes` — nothing committed to the repo. No `.gitattributes` pollution.
- **Configure once, all worktrees inherit**: Worktrees share `.git/config` and inherit `.git/info/attributes` via `commondir`. One-time setup on the main repo covers all current and future worktrees.
- **Setup on project init**: `ensureWeaveConfigured()` runs when a project is added via `addProject()`. If Weave isn't installed, it bails silently — no error, no degradation.
- **Manual re-setup via project settings**: A "Setup Weave" action in project settings lets users trigger configuration later (e.g., after installing Weave).
- **Blanket file extension coverage**: All 18+ Weave-supported languages are configured. Weave falls back gracefully for unsupported content, so there's no harm in over-including.
- **Idempotent setup**: Safe to run multiple times. Checks before appending to `info/attributes`, uses `--replace-all` for git config.
- **Optional dependency**: Weave is not bundled or auto-installed. If `weave-driver` is not on PATH, the feature is silently inactive and merges work exactly as before.

- **UI: Setup action in project settings**: The General section of project settings (`SettingsDetailView.tsx`) gets a "Semantic Merge (Weave)" row. It shows the current status (configured / not configured / weave-driver not found) and a "Configure" or "Reconfigure" button. This is not a toggle — it's a one-time setup action that configures the git merge driver for the project. If `weave-driver` is not installed, the row shows a hint with a link to the Weave repo.
- **Status check endpoint**: A lightweight endpoint to check whether Weave is configured for a project, so the settings UI can show the correct state.

## Non-Goals

- Merge preview UI (`weave-cli preview`)
- Visual conflict resolution or richer conflict markers in the UI
- Bundling or auto-installing Weave
- Modifying `.gitattributes` (committed file)

## Impact

- **`packages/client/src/components/SettingsDetailView.tsx`**: Add "Semantic Merge (Weave)" row to the General settings section. Shows status and a configure/reconfigure button. If `weave-driver` not found, shows install hint with link.
- **`packages/client/src/lib/api.ts`**: New `configureWeave(projectId)` and `getWeaveStatus(projectId)` API methods.
- **`packages/runtime/src/routes/projects.ts`**: New `POST /api/projects/:id/weave/configure` endpoint to trigger setup. New `GET /api/projects/:id/weave/status` endpoint to check current state.
- **`packages/runtime/src/services/project-manager.ts`**: Call `ensureWeaveConfigured()` during `addProject()`.
- **`packages/core/src/git/git.ts`** (or new `weave.ts`): New `ensureWeaveConfigured(projectPath)` function — detects `weave-driver`, writes git config and `info/attributes`. New `getWeaveStatus(projectPath)` function — checks if driver is installed and configured.
- **`packages/core/src/git/git.ts` `mergeBranch()`**: Zero changes.
