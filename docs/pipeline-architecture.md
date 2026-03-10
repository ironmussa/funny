# Pipeline Architecture

## Overview

The pipeline is an automated code review and fix system that runs after every git commit. It uses AI agents to review code changes, identify issues, and automatically fix them in an iterative loop.

**Key design principle:** Every pipeline stage runs in its own **worktree**, ensuring full isolation. Multiple agents can work in parallel without checkout conflicts.

```
                         PIPELINE SYSTEM
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │   ┌─────────────┐     ┌──────────────┐     ┌─────────┐  │
 │   │  STAGE 0    │     │   STAGE 1    │     │ STAGE 2 │  │
 │   │ Pre-commit  │     │   Reviewer   │◄───►│Corrector│  │
 │   │   Fixer     │     │  (read-only) │loop │ (write) │  │
 │   └─────────────┘     └──────────────┘     └─────────┘  │
 │   same worktree        own worktree        own worktree  │
 └──────────────────────────────────────────────────────────┘
```

---

## Why Full Worktree Isolation?

Funny allows **multiple agents to work in parallel**, each on its own branch via git worktrees. Without worktree isolation in the pipeline, we get conflicts:

```
WITHOUT ISOLATION (current — problematic):

  Agent A (worktree: branch-a)  ──commit──► Pipeline reviewer runs in Agent A's cwd
  Agent B (worktree: branch-b)  ──commit──► Pipeline reviewer runs in Agent B's cwd
  Agent C (worktree: branch-c)  ──commit──► Pipeline reviewer runs in Agent C's cwd
                                                │
                                          If corrector needs to apply a patch
                                          back to the parent worktree while the
                                          agent is still working → CONFLICT

WITH ISOLATION (proposed):

  Agent A (worktree: branch-a)  ──commit──► Reviewer gets OWN worktree (branch-a-review-1)
  Agent B (worktree: branch-b)  ──commit──► Reviewer gets OWN worktree (branch-b-review-1)
  Agent C (worktree: branch-c)  ──commit──► Reviewer gets OWN worktree (branch-c-review-1)
                                                │
                                          Corrector gets OWN worktree (branch-a-fix-1)
                                          No conflicts. All isolated.
```

**Benefits:**
- No checkout conflicts between parallel agents
- Parent thread (Agent A) can keep working while pipeline runs
- Clean worktree lifecycle — create, use, delete
- Each stage thread is visible in the sidebar with its own status

---

## Stage 0: Pre-commit Auto-fixer

**When:** During `git commit`, if a pre-commit hook fails.
**Where:** Runs in the **same worktree** as the thread (no new worktree needed — the agent already owns it).
**Agent mode:** `autoEdit` (read-write).

```
 User/Agent runs git commit
         │
         ▼
 ┌───────────────┐
 │  Pre-commit   │
 │  hooks run    │
 └───────┬───────┘
         │
    Hook failed?
    ┌────┴────┐
    │         │
   NO        YES
    │         │
    ▼         ▼
 Commit    ┌──────────────────────┐
 succeeds  │ Is hook auto-fixable?│
           └──────────┬───────────┘
              ┌───────┴───────┐
              │               │
             YES             NO
              │               │
              ▼               ▼
         ┌─────────┐       Commit
         │  Spawn  │       aborted
         │  Fixer  │       (manual fix
         │  Agent  │        needed)
         └────┬────┘vs
              │
              ▼
      ┌───────────────┐
      │ Agent fixes   │
      │ staged files  │
      └───────┬───────┘
              │
              ▼
      ┌───────────────┐
      │ Re-run hook   │◄──────┐
      └───────┬───────┘       │
         ┌────┴────┐         │
         │         │         │
       PASS      FAIL        │
         │         │         │
         ▼         ▼         │
      Continue   attempts    │
      commit     < max? ─────┘
                   │
                  NO
                   │
                   ▼
                Commit
                aborted
```

### Auto-fixable hooks

| Hook | Auto-fixable? |
|------|:---:|
| oxlint | Yes |
| Conflict markers | Yes |
| Console/debugger statements | Yes |
| secretlint | **No** (security — requires manual review) |

### Configuration

| Setting | Default | Range |
|---------|---------|-------|
| `precommitFixEnabled` | `false` | on/off |
| `precommitFixModel` | sonnet | haiku/sonnet/opus |
| `precommitFixMaxIterations` | 3 | 1-5 |

---

## Stage 1: Reviewer

**When:** After a commit is created (`git:committed` event).
**Where:** **New worktree thread** (isolated read-only copy).
**Agent mode:** `plan` (read-only).

```
 git:committed event
 (from parent thread's worktree)
         │
         ▼
 ┌───────────────────────┐
 │ pipeline-trigger-     │
 │ handler               │
 │                       │
 │ Check:                │
 │ - Pipeline enabled?   │
 │ - Is pipeline commit? │
 └───────────┬───────────┘
             │
        ┌────┴────┐
        │         │
    New commit  Pipeline commit
        │      (from corrector)
        ▼         │
    Create new    ▼
    pipeline    Continue
    run         existing run
        │         │
        ├─────────┘
        ▼
 ┌───────────────────────────────┐
 │ runReviewerStage()            │
 │                               │
 │ 1. Create new worktree thread │
 │    branch: <parent>-review-N  │
 │    mode: worktree             │
 │    permissionMode: plan       │
 │                               │
 │ 2. Agent runs in its own      │
 │    isolated worktree:         │
 │    - git diff SHA~1..SHA      │
 │    - Analyze changes          │
 │    - Produce verdict          │
 └───────────────┬───────────────┘
                 │
                 ▼
 ┌───────────────────────┐
 │ Parse verdict JSON    │
 │                       │
 │ {                     │
 │   "verdict": "pass",  │
 │   "findings": [...]   │
 │ }                     │
 └───────────┬───────────┘
             │
        ┌────┴────┐
        │         │
      PASS      FAIL
        │         │
        ▼         ▼
    Complete    iteration
    run as     < max?
    "completed" ┌──┴──┐
                │     │
               YES   NO
                │     │
                ▼     ▼
           Stage 2  Complete
                    run as
                    "failed"
```

### Reviewer verdict format

```json
{
  "verdict": "pass | fail",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "category": "bug | security | performance | logic | style",
      "file": "path/to/file.ts",
      "line": 42,
      "description": "What is wrong",
      "suggestion": "How to fix it"
    }
  ]
}
```

### Configuration

| Setting | Default | Range |
|---------|---------|-------|
| `reviewModel` | sonnet | haiku/sonnet/opus |
| `maxIterations` | 10 | 1-20 |

---

## Stage 2: Corrector

**When:** Reviewer verdict is `fail` and iterations remaining.
**Where:** **New worktree thread** (isolated branch — already works this way).
**Agent mode:** `autoEdit` (read-write).

```
 Reviewer verdict = FAIL
         │
         ▼
 ┌──────────────────────────────┐
 │ runCorrectorStage()          │
 │                              │
 │ 1. Create new worktree       │
 │    thread                    │
 │    branch: <parent>-fix-N    │
 │    mode: worktree            │
 │    title: "Pipeline fix      │
 │    (iteration N)"            │
 └───────────────┬──────────────┘
                 │
                 ▼
 ┌──────────────────────────────┐
 │ Agent runs in its own        │
 │ isolated worktree:           │
 │                              │
 │ 1. Read findings             │
 │ 2. Fix files                 │
 │ 3. bun run build             │
 │ 4. bun run test              │
 │ (does NOT commit)            │
 └───────────────┬──────────────┘
                 │
                 ▼
 ┌──────────────────────────────┐
 │ handleCorrectorDone()        │
 │                              │
 │ 1. git status --porcelain    │
 │    in corrector worktree     │
 └───────────────┬──────────────┘
                 │
            ┌────┴────┐
            │         │
        Changes?   No changes
            │         │
            ▼         ▼
  ┌────────────┐   Complete
  │ git add -A │   run as
  │ git diff   │   "skipped"
  │  --cached  │
  └──────┬─────┘
         │
         ▼
 ┌──────────────────────────────┐
 │ Apply patch to PARENT        │
 │ thread's worktree            │
 │                              │
 │ git apply --index            │
 │ (stdin: diff from corrector  │
 │  worktree)                   │
 └───────────────┬──────────────┘
                 │
                 ▼
 ┌──────────────────────────────┐
 │ Commit on parent thread's    │
 │ worktree                     │
 │                              │
 │ Message:                     │
 │ "fix: address review         │
 │  findings (pipeline          │
 │  run <id>, iter N)"          │
 │                              │
 │ Metadata:                    │
 │ isPipelineCommit=true        │
 │ pipelineRunId=<id>           │
 └───────────────┬──────────────┘
                 │
                 ▼
          git:committed event
          (loops back to Stage 1)
```

### Configuration

| Setting | Default | Range |
|---------|---------|-------|
| `fixModel` | sonnet | haiku/sonnet/opus |
| `maxIterations` | 10 | 1-20 (shared with reviewer) |

---

## Complete Flow (End to End)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ PARENT THREAD (Agent working in its own worktree: branch-feature-x)    │
│                                                                        │
│   Agent works... → git commit                                          │
│                       │                                                │
│                  ┌────┴────┐                                           │
│               HOOK OK   HOOK FAIL                                      │
│                  │         │                                            │
│                  │    ┌────────────────────┐                            │
│                  │    │ STAGE 0            │                            │
│                  │    │ Pre-commit Fix     │                            │
│                  │    │ (same worktree)    │                            │
│                  │    └────────┬───────────┘                            │
│                  │             │                                        │
│                  ├─────────PASS─────────┐                               │
│                  │                      │                               │
│                  ▼                   FAIL (max attempts)                │
│          ┌──────────────┐               │                              │
│          │ Commit OK    │            Commit aborted                     │
│          │ git:committed│                                              │
│          └──────┬───────┘                                              │
│                 │                                                      │
└─────────────────┼──────────────────────────────────────────────────────┘
                  │
                  ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                    PIPELINE TRIGGERED                        │
    │                                                              │
    │  ┌─────────────────────────────────────────────────────┐     │
    │  │ STAGE 1: REVIEWER (own worktree: branch-review-1)   │     │
    │  │                                                     │     │
    │  │  New thread created in its own worktree              │     │
    │  │  Agent analyzes the diff (read-only)                 │     │
    │  │  Produces verdict JSON                               │     │
    │  └──────────────────────┬──────────────────────────────┘     │
    │                         │                                    │
    │                    ┌────┴────┐                                │
    │                    │         │                                │
    │                  PASS      FAIL                               │
    │                    │         │                                │
    │                    ▼         ▼                                │
    │              ┌────────┐  iterations < max?                    │
    │              │  DONE  │  ┌──────┴──────┐                     │
    │              │  pass  │  │             │                      │
    │              └────────┘ YES           NO                     │
    │                          │             │                      │
    │                          ▼             ▼                      │
    │    ┌─────────────────────────────┐  ┌────────┐               │
    │    │ STAGE 2: CORRECTOR          │  │  DONE  │               │
    │    │ (own worktree: branch-fix-1)│  │  fail  │               │
    │    │                             │  └────────┘               │
    │    │ New thread in new worktree   │                           │
    │    │ Agent fixes issues           │                           │
    │    │ Changes patched back to      │                           │
    │    │ parent thread's worktree     │                           │
    │    │ Commit on parent branch      │                           │
    │    └──────────────┬──────────────┘                            │
    │                   │                                           │
    │                   │ git:committed                             │
    │                   │ (isPipelineCommit=true)                   │
    │                   │                                           │
    │                   └─────────► Back to STAGE 1                 │
    │                               (iteration++)                   │
    │                               (new reviewer worktree)         │
    └──────────────────────────────────────────────────────────────┘
```

---

## Parallel Agents — No Conflicts

```
 ┌──────────────────────────────────────────────────────────────┐
 │ PROJECT: my-app                                              │
 │ Main repo at: /home/user/my-app                              │
 │ Worktrees at: /home/user/.funny-worktrees/my-app/            │
 │                                                              │
 │  AGENT A                          AGENT B                    │
 │  worktree: feat-auth              worktree: feat-cart         │
 │  ┌──────────────────┐            ┌──────────────────┐        │
 │  │ Working...       │            │ Working...       │        │
 │  │ commit → pipeline│            │ commit → pipeline│        │
 │  └────────┬─────────┘            └────────┬─────────┘        │
 │           │                               │                  │
 │           ▼                               ▼                  │
 │  ┌──────────────────┐            ┌──────────────────┐        │
 │  │ Reviewer          │            │ Reviewer          │        │
 │  │ worktree:         │            │ worktree:         │        │
 │  │ feat-auth-rev-1   │            │ feat-cart-rev-1   │        │
 │  └────────┬─────────┘            └────────┬─────────┘        │
 │           │ FAIL                          │ PASS              │
 │           ▼                               ▼                  │
 │  ┌──────────────────┐              ✅ DONE                   │
 │  │ Corrector         │                                       │
 │  │ worktree:         │                                       │
 │  │ feat-auth-fix-1   │                                       │
 │  └────────┬─────────┘                                        │
 │           │ patch → feat-auth                                │
 │           │ commit → re-review                               │
 │           ▼                                                  │
 │  ┌──────────────────┐                                        │
 │  │ Reviewer          │                                        │
 │  │ worktree:         │                                        │
 │  │ feat-auth-rev-2   │   ← NO CONFLICTS with Agent B!       │
 │  └──────────────────┘                                        │
 │                                                              │
 │  Each pipeline stage has its own worktree.                    │
 │  No checkouts, no conflicts, fully parallel.                  │
 └──────────────────────────────────────────────────────────────┘
```

---

## Two Scenarios: Worktree Thread vs Local Thread

The pipeline works the same way regardless of how the parent thread was created. The **only difference** is where the corrector's patch gets applied at the end.

### Scenario A: Parent thread started in Worktree mode (recommended)

```
┌──────────────────────────────────────────────────────────────────┐
│ PARENT THREAD                                                     │
│ Mode: worktree                                                    │
│ Working dir: ~/.funny-worktrees/my-app/feat-auth/                 │
│ Branch: feat-auth                                                 │
│                                                                   │
│   Agent works → git commit → pre-commit hooks (Stage 0)           │
│                                   │                               │
│                              git:committed                        │
└──────────────────────────────┬────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ PIPELINE                                                          │
│                                                                   │
│  Stage 1: REVIEWER                                                │
│  ┌──────────────────────────────────────────────────────┐         │
│  │ New worktree thread                                   │         │
│  │ Branch: feat-auth-pipeline-review-1                   │         │
│  │ Dir: ~/.funny-worktrees/my-app/feat-auth-review-1/    │         │
│  │ Mode: plan (read-only)                                │         │
│  │                                                       │         │
│  │ Analyzes diff → produces verdict                      │         │
│  └───────────────────────────┬───────────────────────────┘         │
│                              │                                     │
│                         ┌────┴────┐                                │
│                       PASS      FAIL                               │
│                         │         │                                │
│                         ▼         ▼                                │
│                       DONE    Stage 2: CORRECTOR                   │
│                               ┌──────────────────────────────┐     │
│                               │ New worktree thread           │     │
│                               │ Branch: feat-auth-fix-1       │     │
│                               │ Dir: ~/.funny-worktrees/      │     │
│                               │      my-app/feat-auth-fix-1/  │     │
│                               │ Mode: autoEdit (read-write)   │     │
│                               │                               │     │
│                               │ Fixes issues → generates diff │     │
│                               └───────────────┬───────────────┘     │
│                                               │                     │
│                                               ▼                     │
│                                 ┌──────────────────────────┐        │
│                                 │ PATCH APPLIED TO:         │        │
│                                 │ ► Parent's WORKTREE       │        │
│                                 │   ~/.funny-worktrees/     │        │
│                                 │   my-app/feat-auth/       │        │
│                                 │                           │        │
│                                 │ Commit on feat-auth       │        │
│                                 │ → loops back to Stage 1   │        │
│                                 └──────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

**Key:** The patch is applied to the **parent's worktree directory**. The user's actual project directory (`/home/user/my-app/`) is never touched.

---

### Scenario B: Parent thread started in Local mode

```
┌──────────────────────────────────────────────────────────────────┐
│ PARENT THREAD                                                     │
│ Mode: local                                                       │
│ Working dir: /home/user/my-app/              (user's real dir!)   │
│ Branch: master (whatever is currently checked out)                 │
│                                                                   │
│   Agent works → git commit → pre-commit hooks (Stage 0)           │
│                                   │                               │
│                              git:committed                        │
└──────────────────────────────┬────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ PIPELINE                                                          │
│                                                                   │
│  Stage 1: REVIEWER                                                │
│  ┌──────────────────────────────────────────────────────┐         │
│  │ New worktree thread                                   │         │
│  │ Branch: master-pipeline-review-1                      │         │
│  │ Dir: ~/.funny-worktrees/my-app/master-review-1/       │         │
│  │ Mode: plan (read-only)                                │         │
│  │                                                       │         │
│  │ Analyzes diff → produces verdict                      │         │
│  └───────────────────────────┬───────────────────────────┘         │
│                              │                                     │
│                         ┌────┴────┐                                │
│                       PASS      FAIL                               │
│                         │         │                                │
│                         ▼         ▼                                │
│                       DONE    Stage 2: CORRECTOR                   │
│                               ┌──────────────────────────────┐     │
│                               │ New worktree thread           │     │
│                               │ Branch: master-fix-1          │     │
│                               │ Dir: ~/.funny-worktrees/      │     │
│                               │      my-app/master-fix-1/     │     │
│                               │ Mode: autoEdit (read-write)   │     │
│                               │                               │     │
│                               │ Fixes issues → generates diff │     │
│                               └───────────────┬───────────────┘     │
│                                               │                     │
│                                               ▼                     │
│                                 ┌──────────────────────────┐        │
│                                 │ PATCH APPLIED TO:         │        │
│                                 │ ► User's LOCAL DIRECTORY  │        │
│                                 │   /home/user/my-app/      │        │
│                                 │                           │        │
│                                 │ ⚠️  User may have unsaved │        │
│                                 │    changes in their editor│        │
│                                 │                           │        │
│                                 │ Commit on master          │        │
│                                 │ → loops back to Stage 1   │        │
│                                 └──────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

**Key:** The patch is applied to the **user's actual project directory**. This is riskier because:
- The user may be editing files in their IDE while the pipeline runs
- If the user has unstaged changes, `git apply` could fail
- Only one agent can safely use local mode at a time

---

### Comparison table

| Aspect | Worktree mode (A) | Local mode (B) |
|--------|-------------------|----------------|
| Parent thread's cwd | `~/.funny-worktrees/<project>/<branch>/` | `/home/user/<project>/` |
| Pipeline stages | Own worktrees (same for both) | Own worktrees (same for both) |
| Patch destination | Parent's worktree (isolated) | User's actual directory |
| Safe for parallel agents? | **Yes** — each agent has its own worktree | **No** — only one local agent at a time |
| Risk of conflict with user? | **None** — user's directory untouched | **Possible** — user may be editing same files |
| Recommended for pipelines? | **Yes** | Use with caution |

### Pipeline code — same in both cases

The pipeline orchestrator doesn't need to know whether the parent thread is local or worktree. It just uses `parentCwd` (the thread's working directory) which is:
- **Worktree mode:** the worktree path (e.g., `~/.funny-worktrees/my-app/feat-auth/`)
- **Local mode:** the project path (e.g., `/home/user/my-app/`)

The pipeline always:
1. Creates its own worktrees for reviewer and corrector stages
2. Uses `parentCwd` as the target when applying patches
3. Commits on the parent thread's branch

No special handling is needed — the `parentCwd` abstraction makes both scenarios identical from the pipeline's perspective.

---

## Worktree Naming Convention

Each pipeline stage thread gets a worktree with a predictable branch name:

| Stage | Branch pattern | Example |
|-------|---------------|---------|
| Parent thread | `<branch>` | `feat-auth` |
| Reviewer (iter 1) | `<branch>-pipeline-review-1` | `feat-auth-pipeline-review-1` |
| Corrector (iter 1) | `<branch>-pipeline-fix-1` | `feat-auth-pipeline-fix-1` |
| Reviewer (iter 2) | `<branch>-pipeline-review-2` | `feat-auth-pipeline-review-2` |

Worktree paths follow the existing convention:
```
~/.funny-worktrees/<project-name>/<branch-name>/
```

---

## Worktree Lifecycle

```
 Pipeline starts
      │
      ▼
 Create reviewer worktree ─── Reviewer runs ─── Parse verdict
      │                                              │
      │                                         ┌────┴────┐
      │                                       PASS      FAIL
      │                                         │         │
      ▼                                         │         ▼
 Delete reviewer worktree ◄─────────────────────┘    Create corrector
                                                      worktree
                                                           │
                                                      Corrector runs
                                                           │
                                                      Generate patch
                                                           │
                                                      Apply to parent
                                                           │
                                                      Delete corrector
                                                      worktree
                                                           │
                                                      Commit on parent
                                                           │
                                                      Create NEW reviewer
                                                      worktree (next iter)
```

**Important:** Worktrees are cleaned up after each stage completes to avoid disk bloat. The `thread-service` already handles worktree cleanup when threads are deleted.

---

## Infinite Loop Prevention

The system prevents infinite review loops using metadata:

1. Before the corrector commits, a one-time event listener is registered
2. The listener tags the next `git:committed` event with:
   - `isPipelineCommit = true`
   - `pipelineRunId = <current run ID>`
3. The trigger handler detects these flags and continues the **existing** run instead of creating a new one
4. The iteration counter increments, ensuring it eventually reaches `maxIterations`

---

## Event System

### Internal events (threadEventBus)

| Event | Emitter | Listener |
|-------|---------|----------|
| `git:committed` | git-workflow-service | pipeline-trigger-handler |
| `agent:completed` | agent-runner | pipeline-completed-handler |
| `thread:created` | thread-service | pipeline-orchestrator |

### WebSocket events (to client)

| Event | When | Key data |
|-------|------|----------|
| `pipeline:run_started` | New run begins | `pipelineId`, `runId`, `commitSha` |
| `pipeline:stage_update` | Stage changes | `stage`, `iteration`, `verdict`, `findings` |
| `pipeline:run_completed` | Run finishes | `status` (completed/failed/skipped), `totalIterations` |

---

## Database

### `pipelines` (configuration)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Pipeline ID |
| `projectId` | TEXT FK | Associated project |
| `userId` | TEXT | Owner |
| `name` | TEXT | Display name |
| `enabled` | INTEGER | Toggle (0/1) |
| `reviewModel` | TEXT | Model for reviewer |
| `fixModel` | TEXT | Model for corrector |
| `maxIterations` | INTEGER | Max review-fix cycles (default: 10) |
| `precommitFixEnabled` | INTEGER | Toggle pre-commit fixer (0/1) |
| `precommitFixModel` | TEXT | Model for pre-commit fixer |
| `precommitFixMaxIterations` | INTEGER | Max fix attempts (default: 3) |

### `pipeline_runs` (execution state)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Run ID |
| `pipelineId` | TEXT FK | Parent pipeline |
| `threadId` | TEXT | Source thread |
| `status` | TEXT | running/reviewing/fixing/completed/failed/skipped |
| `currentStage` | TEXT | reviewer/corrector |
| `iteration` | INTEGER | Current iteration |
| `commitSha` | TEXT | Commit being reviewed |
| `verdict` | TEXT | pass/fail |
| `findings` | TEXT | JSON array of issues |
| `fixerThreadId` | TEXT | Corrector's worktree thread |
| `reviewerThreadId` | TEXT | Reviewer's worktree thread (**new**) |

---

## Implementation Status

All stages now use full worktree isolation:

| Stage | Isolation | Status |
|-------|-----------|--------|
| **Stage 0** (Pre-commit fixer) | Same worktree (agent already owns it) | Done |
| **Stage 1** (Reviewer) | Own worktree thread (`plan` mode) | Done |
| **Stage 2** (Corrector) | Own worktree thread (`autoEdit` mode) | Done |
| Pipeline run tracking | `reviewerThreadId` + `fixerThreadId` in DB | Done |
| Worktree cleanup | Auto-cleanup after each stage completes | Done |

---

## Key Files

| File | Role |
|------|------|
| `server/src/services/pipeline-orchestrator.ts` | Core orchestration — stages 1 & 2 |
| `server/src/services/git-workflow-service.ts` | Stage 0 (pre-commit auto-fix) |
| `server/src/services/handlers/pipeline-trigger-handler.ts` | Listens for `git:committed` → starts review |
| `server/src/services/handlers/pipeline-completed-handler.ts` | Listens for `agent:completed` → advances stage |
| `server/src/routes/pipelines.ts` | REST API endpoints |
| `client/src/components/PipelineProgressBanner.tsx` | Real-time status banner |
| `client/src/components/PipelineSettings.tsx` | Configuration dialog |
| `client/src/stores/pipeline-store.ts` | Client state (Zustand) |
| `core/src/git/worktree.ts` | Worktree creation/deletion utilities |
| `server/src/services/thread-service.ts` | Thread creation with worktree setup |
