# Design

## Context

See proposal.md, Why. The runner's `change-delta` step (`runtime/services/factory-change-delta.ts`)
parses `git diff -U0 --no-renames` of each commit against its fork point with the base into, per
file, the multiset of added and removed lines. `deltaOf` compares the two changes file by file,
and `outsideFrom` lists the differing files that the change at A did not have. The server
(`factory-approval-carry.ts`, `approvalCovers`) refuses any `outsideFrom`.

What the three refused runs had in common (checked with a prototype of the rules below against
their commits):

| Run  | Differing lines (per file) | Outside files | What the outside edits did                                                                    | Over the whole change |
| ---- | -------------------------- | ------------- | --------------------------------------------------------------------------------------------- | --------------------- |
| #478 | 175                        | 6             | fixed new warnings in code from #477, and carried edits #511 moved into `suggestion-items.ts` | 99                    |
| #450 | 33                         | 1             | fixed a warning in `factory-agent-tools.ts`, new on master                                    | 33                    |
| #458 | 61                         | 1             | fixed a `typeof` in `FactoryApprovalRequestCard.tsx`, new on master                           | 61                    |

In every outside file the base had changed the file after A split from it, and the change at B
removed only lines the base had added.

## Goals / Non-Goals

**Goals:**

- Cover the edits an implementer makes to the base's new code after a base merge.
- Count an edit that moved with its code once.
- Keep every other refusal of `approvalCovers`, and keep the decision pure on the server.

**Non-Goals:**

- Discounting edits the base made moot (A edited a line the base then deleted). That would have
  taken #478 from 99 to 86 lines. It is left out to keep the rule simple. Raising the limit
  covers it.
- Reporting every refusal reason instead of the first one. That is a separate, small change.
- Changing the limit's range or its default.

## Decisions

### D1. The runner computes the base's own change and classifies the outside files

The runner already has both fork points. It adds a third parse: the base's change from fork(A)
to fork(B) (`git diff -U0 --no-renames fork(A) fork(B)`), which gives what the base added and
removed per file. For each file in `outsideFrom` the runner reports it as **base-brought** when
the base changed it in that range and every line the change at B removes from it is among the
lines the base added (counting repeats). The result gains `baseBrought: string[]`. A
base-brought file stays in `outsideFrom` too, so the server decides.

_Alternative:_ the server asks GitHub for the base's commits and their files. Rejected: it needs
the lines, not only the file names, and the runner already has the checkout and the fetch.

_Alternative:_ git rename/copy detection (`-M -C`) to find split files. Rejected: a split leaves
a small part of a large file, below any useful similarity threshold (`PromptEditor.tsx` →
`suggestion-items.ts`), and it misses the main case, new code that is not a copy of anything.

### D2. Moved edits are matched across files, only into base-brought files

`lines` stays the per-file count, for old servers. The runner adds `linesAcrossMoves`: the same
count, except that a line missing from one file's change and present in a base-brought file's
change (same sign: added in both, or removed in both) is paired and counts as zero. Pairing is
only into base-brought files. Between files the change at A touched, a line that leaves one and
appears in another is still a real move of code nobody approved, so it counts. The server uses
`linesAcrossMoves` for the limit when the runner sends it.

_Alternative:_ match across all files. Rejected for the reason above: it would hide a move
between two approved files.

### D3. Compatibility through optional fields

`baseBrought` and `linesAcrossMoves` are optional in `changeDeltaResultSchema`. An absent field
means an old runner: the server applies today's rule (no outside file, per-file lines). A new
runner with an old server is harmless: the old server ignores the fields. Server and runner can
be deployed in either order.

### D4. `approvalCovers` order

1. No delta → refused. Not an ancestor → refused. Zero lines → `same`.
2. The limit is measured on `linesAcrossMoves ?? lines`.
3. An `outsideFrom` file that is not in `baseBrought` → refused (the current message).
4. A risk key that A did not have → refused. This is what stops a sensitive path or a weakened
   test that the base brought, since the classification of B reports them.

A `same` verdict still requires `lines === 0` (per file). A change that is zero only across
moves is an adjustment, so it is recorded and announced as such.

### D5. The record says which files came from the base

`ApprovalCoverage` with `kind: 'adjustment'` gains `baseBrought: string[]`. The PR comment and
the `factory.approval-moved` activity list them under "code the base brought, which the change
now also fixes". The run's `gap` (when an approval is refused) gains the same list, so the
`ApprovalGapNote` shows which outside files were accepted and which one was not.

## Risks / Trade-offs

- [An implementer could rewrite base code it was not asked to touch] → Only lines the base added
  after A was approved can be removed. Code a member never saw in this PR has been reviewed in
  its own PR. The limit, the risk reasons (sensitive paths, weakened tests) and the review of B
  still apply.
- [A line common to many files (`}`, an import) pairs a moved edit by chance] → Pairing only
  goes into base-brought files and only lowers the count of lines that are actually equal. At
  worst a coincidental pair saves one line of the limit.
- [Third parse on large bases] → It is one more `git diff -U0` within the existing step and its
  timeout. When the base moved by thousands of files the step can time out, and the approval
  then does not move, as today.

## Migration Plan

Deploy order does not matter (D3). Rollback: revert either side. The old server ignores the new
fields, and an old runner leaves them out.
