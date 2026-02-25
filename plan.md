# Plan: Make `issueNumber` optional — support prompt-only sessions

## Problem
The agent requires a GitHub issue number to start a session. If the issue doesn't exist or no tracker is configured, the pipeline fails with 502. Users should be able to start sessions with just a prompt.

## Approach
When no `issueNumber` is provided, build a synthetic `IssueRef` from the `prompt` field. Use `number: 0` to signal "no real issue". The rest of the pipeline (plan → implement → PR) runs identically.

---

## Changes (5 files)

### 1. `packages/agent/src/routes/sessions.ts`
- Schema: make `issueNumber` optional, add `prompt: z.string()` as primary input
- When `issueNumber` is missing + no tracker: build `IssueRef` from `prompt` (number=0, title=first 80 chars of prompt, body=full prompt)
- When `issueNumber` is present: current behavior (tracker lookup or inline)
- Skip `byIssue` duplicate check when number is 0
- Branch name: `prompt/<slug>-<nanoid>` instead of `issue/N/<slug>-<nanoid>`
- PR title: `feat: <title>` (no `Closes #0`) when number is 0

### 2. `packages/agent/src/core/session.ts`
- No type changes — `IssueRef.number` stays `number`, we use 0 for prompt-only

### 3. `packages/agent/src/core/session-store.ts`
- `byIssue()`: return `undefined` when queried with 0 (skip matching synthetic sessions)

### 4. `packages/agent/src/core/orchestrator-agent.ts`
- `buildPlanningPrompt()`: when `issue.number === 0`, say "## Task: <title>" instead of "## Issue #0: <title>"
- `buildImplementingPrompt()`: same — "Task: <title>" when number is 0
- Commit message: `feat(scope): description` without `(Closes #0)` when number is 0

### 5. `packages/agent/src/validation/schemas.ts`
- Make `issue_number` optional

## What stays unchanged
- Pipeline flow, state machine, event bus, ingest adapter, reactions, tracker interface
