# Proposal

## Why

A merge approval follows an adjustment only when the differing lines stay in files the approved
change already touched. In the lint-cleanup runs that rule, not the line limit, is what loses
approvals. Between the approval and the merge, master gains new code (often another lint PR
that splits files) and the implementer fixes it to keep its acceptance criterion ("0
warnings"). Of the four approvals lost on 2026-11-24 and 25 (#450, #458, #478 and an uncertain
#456), three were refused for that reason. Measured file by file, #478 also counts its edits
twice when the base moves the code they were in to another file (175 lines; 99 measured over
the whole change).

## What Changes

- The difference between the approved change and the new one is measured over the whole
  change, not file by file, for the files the base moved code into. An edit that moved with its
  code no longer counts as a removed line plus an added line.
- An adjustment may touch a file the approved change did not touch when the base changed that
  file between the two commits' fork points, and every line the change removes there is a line
  the base brought in. That is the case of the implementer fixing the base's new code.
  A file the base did not change is still refused, as are new risk reasons, a branch that lost
  the approved commit and a difference over the limit.
- The approval's PR comment and activity list those files apart ("code the base brought").
- A runner without the new comparison keeps today's file-by-file answer, so server and runner
  can be deployed in either order.

With the factory's limit at 100 lines, #450 (33 lines), #458 (61) and #478 (99) would each have
merged with one approval.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `issue-factory`: the requirement "A merge approval may follow a small adjustment" (added by
  `factory-approval-survives-integration`) also covers a file the base changed and the change
  only fixes, and measures moved edits once.

## Impact

- `packages/runtime/src/services/factory-change-delta.ts`: the base's own change between the
  two fork points, the whole-change line count, the files the base brought.
- The `change-delta` step result (`changeDeltaResultSchema` in `server/services/factory/factory-step-runner.ts`, `ChangeDeltaResult` in the runtime): new optional fields.
- `packages/server/src/services/factory/factory-approval-carry.ts`, the approval-moved comment
  and activity, and the `ApprovalGapNote` text.
- Depends on `factory-approval-survives-integration` and `factory-merge-fewer-bounces`, which
  must be archived first (this change modifies their requirement).
