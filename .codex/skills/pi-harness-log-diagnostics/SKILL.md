---
name: pi-harness-log-diagnostics
description: Log-first diagnostic workflow for pi-harness runs. Use when the user asks to review traces, inspect logs, compare runs, investigate harness behavior, make harness adjustments from recorded evidence, or avoid coupling the workflow to application code. Prefer summary.json, trace.jsonl, harness scripts, fixtures, and tests over broad repository review; inspect application code only to confirm a concrete hypothesis from the logs.
---

# Pi Harness Log Diagnostics

## Purpose

Diagnose `pi-harness` behavior from recorded run artifacts first. The skill is
for harness feedback loops, not general code review.

Do not edit application code by default. If the user asks for a fix, prefer
changes to harness parsing, reporting, fixtures, comparisons, scripts, or tests
when the logs show the harness is the surface that needs adjustment.

## Inputs

Accept any of these:

- no identifier: inspect the newest relevant run under `~/.pi-codex/runs/funny/`
- session id: inspect `~/.pi-codex/runs/funny/<session-id>/`
- run id: find a matching `~/.pi-codex/runs/funny/*/<run-id>/`
- path to `summary.json`, `trace.jsonl`, output logs, benchmark files, or a run directory
- a harness question such as timeouts, failed tools, noisy output, missing validation, or bad comparison output

If an identifier is ambiguous, list the matching paths and use the newest match
unless the user asks to pause.

## Workflow

1. Locate run artifacts:

   ```bash
   ls -td ~/.pi-codex/runs/funny/*/* 2>/dev/null | head -20
   find ~/.pi-codex/runs/funny -name summary.json 2>/dev/null | sort | tail -20
   ```

2. Read `summary.json` before `trace.jsonl`. Extract run identity, counts,
   errors, timeouts, output volume, and command mix before reading verbose logs.

3. Build hypotheses from logs only:

   - repeated tool failures or timeouts
   - missing verification after edits
   - excessive shell output or redundant reads
   - parser/schema mismatches
   - benchmark or comparison drift
   - incomplete trace capture
   - harness output that hides the actionable failure

4. Inspect `trace.jsonl` narrowly for the specific events behind each
   hypothesis. Do not scan unrelated application code unless the trace points to
   a concrete contract, path, command, or fixture.

5. When code inspection is needed, start in harness-owned surfaces:

   - `packages/harness`
   - harness tests and fixtures
   - scripts or package commands that create, summarize, or compare runs
   - docs or specs that define run artifact formats

6. If making harness changes, keep them evidence-backed:

   - preserve existing artifact contracts unless the logs prove they are wrong
   - add or update focused harness tests for parser, summary, comparison, or
     reporting behavior
   - avoid special-casing one run when a general rule can be derived from the
     logs
   - follow root `AGENTS.md`; run `bun run lint` and `bun run typecheck` before
     considering code changes complete

7. Report concise evidence:

   - run/session/path inspected
   - log facts that drove the conclusion
   - harness files or tests touched, if any
   - verification commands and outcomes
   - residual uncertainty when logs are incomplete

## Summary Signals

Useful `summary.json` fields include:

- `projectId`, `sessionId`, `leafId`, `runId`
- `toolCallCount`, `toolErrorCount`, `timeoutCount`
- `toolCallsByName`, `toolErrorsByName`
- `toolOutputBytes`, `applyPatchErrorCount`
- `readManyCallCount`, `codeSearchCallCount`, `shellCallCount`

Treat these as harness signals, not conclusions. Confirm the relevant events in
`trace.jsonl` before recommending or making a harness change.

## Output Shape

Use this structure for investigations:

```md
Evidence
- run/session/path:
- key log facts:

Diagnosis
- ...

Harness Changes
- changed/not changed:
- files:

Verification
- ...

Residual Risk
- ...
```

If there is no actionable harness issue, say that directly and identify what
additional log signal would be needed.
