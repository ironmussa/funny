# Design

## Context

See proposal.md (Why). The relevant current state:

- A server factory run executes a flow (`issue-to-merge` by default) through
  `factory-action-provider.ts`. The first agent step is a new thread on the enabler's runtime;
  every later agent step is a follow-up on that thread (`threadFor`). `wait_ci` and `merge`
  run on the server with the App token capped by the enabler (`factory-ci-actions.ts`), and
  `merge` merges, or enables auto-merge, on green checks only.
- `wait_ci` judges the checks of the pull request's head commit. It does not know which
  default-branch commit those checks ran against, so two runs green on the same old base can
  both merge.
- The factory refuses `output_format`; an agent step's result is the thread's final message.
- `factory-flow-step-options` (in progress) adds per-step options and `thread: new` read-only
  steps launched like the first step and recorded in `threadIds`. This design builds on it.
- Run states are a compare-and-set machine in `factory-runs.ts` (`QUEUE_TRANSITIONS`,
  `updateInFlight`, `advance`, `reopen`, `closeParked`); `docs/architecture/state-machines.md`
  lists it.
- The App manifest requests `SANDBOX_PERMISSIONS.write`: `pull_requests: write`, but
  `checks: read` and `statuses: read`.

## Goals / Non-Goals

**Goals:**

- Each agent role has a fixed input, permission set, lifetime and result schema, enforced by
  the server, not by the prompt.
- Nothing reaches the default branch without an independent verdict on the exact commit and
  green checks on the current default branch, unless the flow file on the default branch opts
  out explicitly.
- Everything new is a stored state with compare-and-set transitions; restarts resume.

**Non-Goals:**

- A long-lived "merge agent" or any agent holding merge permission.
- A separate test-writing agent (the deterministic test-weakening check comes first; a flow can
  add a `thread: new` step later).
- Batching, bisection, the deterministic `integrate` step, regenerators, early integration and
  stacked pull requests: they are `factory-integration`, which builds on the `merge` node and the
  `address` loop defined here. This change's merge lane is that queue's batch of one.
- Coordinating two users' factories beyond the shared merge lane (each factory still runs as its
  enabler).
- Automatic merge of revert pull requests (v1 opens them; a person merges).
- Token budgets per run.

## Decisions

### D1. Roles are step kinds with server-owned contracts, not free `spawn_agent` steps

`triage` and `review` are new workflow step kinds. The server fixes what makes them
independent: `thread: new`, `permission_mode: plan`, write tools denied, the inputs it passes
and the result schema. A flow may set `provider` / `model` / `effort` and `prompt_file` (to
replace the instructions, not the contract). Implementer steps stay `spawn_agent` /
`before_retry` on the first thread. The sentinel is not a flow step: it belongs to the
repository, not to a run.

The correction loops are engine loops (`workflow-dag-engine`, D3), visible in the graph. The
built-in `issue-to-merge` is:

```
triage → implement → pull-request → address → regression-proof → ci → review → merge
                                       ▲                                │        │
                                       └── loop ────────────────────────┘        │   review: until pass, max 3
                                       └── loop ─────────────────────────────────┘   merge: until merged, max 3
```

`regression-proof` is the gate `factory-quality-gates` added; it keeps its own retry. `triage`
arrives in phase 2 (D14); until then the flow starts at `implement`. `review` follows `ci` in the
graph, but its agent starts earlier (D7).

`address` is the implementer's follow-up for whatever the last gate reported (review findings,
an integration conflict, checks red on the updated base); its `when` skips it on the first
visit. `ci` keeps its own `retry.before_retry` fix. The two loop regions start at `address` and
are nested. Because a repository flow can draw its own loops, `merge` never trusts the path
that led to it: it re-verifies every precondition on entry (D8).

`factory-flow-step-options` is not implemented yet, so this change does not use its generic
`thread: new` for `spawn_agent`: the `review` step launches its own new read-only thread (the
thread create body already takes `permissionMode`, `disallowedTools`, `provider`, `model` and
`effort`). Until that change lands the reviewer's instructions are fixed on the server and the
step accepts `provider` / `model` / `effort` / `early` only; `prompt_file` arrives with it.

_Alternative:_ `spawn_agent` with `output_format` and conventions. Rejected: a repository flow
could drop `plan` or feed the implementer's thread to the reviewer, and the gate would still
look like a gate.

### D2. Structured results: a fenced JSON block, validated on the server

Each role's prompt ends by asking for one fenced `json` block in the final message. The server
reads the last such block, validates it with the role's zod schema (in
`@funny/shared/contracts/factory`), and on failure sends one follow-up on the same thread asking
to re-emit it. Still invalid → the role's failure rule: triage degrades (the run proceeds
without a contract, flagged `contract: none`); reviewer and sentinel fail closed (no merge;
escalate). The review result carries the `sha` it reviewed; a mismatch with the commit the
server asked about is invalid.

_Alternative:_ runtime structured output. Rejected for now: it differs per provider (Claude SDK,
Codex, ACP), and the server would still validate.

### D3. Inputs per role (what each agent does NOT see is the point)

| Role        | Gets                                                                                                                                                                                                                                               | Never gets               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Triage      | issue URL, read-only checkout of the default branch, paths of runs in flight                                                                                                                                                                       | other threads            |
| Implementer | issue URL, the contract, its own history, then CI failures / findings / conflict diffs as follow-ups                                                                                                                                               | the reviewer's thread    |
| Reviewer    | the contract (the issue URL when the run has none), the commit to review (fetches `origin/<branch>` at that SHA and diffs against the merge base), the PR body, the test-weakening report, the factory's recent and in-flight PRs with their paths | the implementer's thread |
| Sentinel    | the factory merges since the last green default-branch commit (SHA, PR, contract), the failing checks and log tails                                                                                                                                | any run thread           |

Issue text is never inlined in a prompt (unchanged rule); the contract is model output and is
inlined, which is acceptable: it was produced by a read-only agent and the reviewer judges
against it.

### D4. Triage and `needs_info`

New run states `triaging` (holds a slot; short) and `needs_info` (parked, no slot). `ready` →
the run records the contract and continues. `needs_info` → the server posts a comment rendered
from a fixed template: the questions as a quoted list, each at most 300 characters, `@`
mentions and links stripped, at most five questions. `too_big` → the same, with the proposed
split as a list (the server creates no issues). A `needs_info` run is triaged again when the
issue's `updated_at` moves past the triage time (checked on the tick); a member can also Retry.
Label runs in `needs_info` keep the issue out of re-admission until then, like any non-terminal
run (index from migration 098).

Triage runs per issue, never in a batch: putting several untrusted issues in one context would
let one issue steer another's contract, and the contract feeds the reviewer. Cross-issue
signals (overlapping paths, blockers) come from stored data, not from a shared context.

### D5. Path reservation at admission

The contract's `likely_paths` (globs, at most 50) are stored on the run. Before admitting an
issue, the watcher triages it first (triage needs a slot), then the run waits in a new
`reserved_wait` reason if its paths intersect those of a run in `working` / `fixing` /
`reviewing` / `merging`. Because triage happens after admission, the check sits between
`triaging` and implementation: the run releases its slot and goes back to `queued` with
`wait_reason = 'paths overlap #N'`, keeping its contract so it is not triaged twice. Runs without
a contract do not reserve and are not held.

_Alternative:_ hard locks on paths. Rejected: `likely_paths` is a prediction; a soft hold that
the merge lane backs up is enough.

### D6. Test-weakening check and risk class (deterministic, server)

On each head commit (when its checks start, so the report is ready for an early review, D7), the
server reads the pull request's file list and patch and flags: removed test files or test cases, added `.skip` / `.only` / `xit` / `@pytest.mark.skip`
(per-language patterns), lowered coverage thresholds in known config files, and edits under
`.github/workflows/`. The report goes to the reviewer and to the risk class.

Risk class is `low` or `high`: `high` when the diff exceeds 400 changed lines, touches a
sensitive path (default list: `.github/`, `**/migrations/**`, `**/migrate.ts`, `**/auth/**`,
lockfiles excepted; plus the factory's configured list), has a test-weakening flag, or the
contract lists a risk hint. `factory_settings.auto_merge` is `low_risk` (default) or `all`;
`issue-to-pr` flows never merge regardless.

### D7. The review gate

`review` follows `wait_ci` in the graph, so the loops and the join stay simple, but the server
does not wait for green checks to start the reviewer: when `wait_ci` begins watching head commit
S, the action provider starts the review of S (a new read-only thread, as the node would) if no
verdict or review thread exists for S and the factory's `review` stage has a free slot, whose
lease it takes for the node to reuse. The `review` node then takes the stored verdict for the
current head commit, waits for the review in flight, or starts one. When the head commit changes
while a review runs (a CI fix was pushed), or the run ends, the server stops that thread and
discards its result. This removes one CI wait from every round at the price of reviews spent on
commits that CI rejects; a flow turns it off with `review: { early: false }`. Nothing else
changes: the verdict is keyed by commit, and `merge` re-verifies both results on entry (D8).

The reviewer judges against the contract; a run without one (phase 1, or a triage that gave no
valid result) is judged against the issue, which the reviewer reads from its URL like the
implementer does (issue text is still never inlined).

The factory settings show a notice when the `review` step resolves to the same provider and
model as the implementer: the same model tends to miss what it missed while writing. It is a
notice, not a refusal.

Verdict `fail` with a `critical` or `high` finding →
the findings go to the implementer as a follow-up (same path as a CI fix), then `wait_ci` and
`review` run again on the new head commit, through the review loop (D1, `max_iterations` 3,
i.e. two correction rounds). `fail` with only
lower findings counts as `pass` with comments. Rounds exhausted → `waiting_human`. A push after a
`pass` invalidates it (the verdict is keyed by SHA). The server posts every verdict as a pull
request review with event `COMMENT` (never `APPROVE`, so it never counts toward a human
approval requirement) and, when the installation grants `statuses: write`, a `funny/review`
commit status (`success` / `failure`) on that SHA, so a repository can require it.

### D8. `merge` is one at a time per repository, through a concurrency group

The merge lane is the engine's concurrency group on the `merge` node:
`merge:{{inputs.repo}}:{{inputs.base_branch}}`, limit 1. The factory host applies it to every
`merge` node whatever the flow says (it adds the group when missing and its `resolveLimit` pins
the limit to 1), so a repository flow cannot merge two pull requests at once. A run waiting for
the slot is `merging` with the engine's `waiting_slot` state; there is no separate lane table.

On entering the node (after it holds the slot) `merge` re-verifies, without trusting earlier
nodes: a `pass` for the current head SHA (unless `require_review: false`), the risk class
against `auto_merge` (else `waiting_human`), and that the branch still contains the last
reviewed commit. Then it integrates in one of two modes, chosen by reading the base branch's
rules:

- **GitHub merge queue required:** the server enqueues the pull request and watches it; removed
  from the queue with failing checks → the failure goes to the implementer (CI-fix path);
  merged → `merged`.
- **Otherwise:** for the head candidate, if its base is behind, the server calls update-branch
  (a merge commit from the default branch, no checkout), waits for checks on the new head, and
  merges only when green and the base has not moved meanwhile; if it moved, it updates again.
  A new head commit from update-branch does not need a new review when the merge brought in
  only default-branch changes and no conflict was resolved (the PR's own diff is unchanged).

A conflict, or checks red on the updated base, ends the node with feedback and the merge loop
sends the run back to `address` (D1). The factory's `priority` hook orders waiters by admission,
with a run whose issue is blocked by another run's issue after it. The group is shared by every
factory on that repository: ordering crosses users, but each merge uses its own run's
enabler-capped token, so no identity crosses.

A run waiting for the merge slot is in flight and counts toward `maxConcurrent`. This is meant:
a slow lane then slows admissions instead of piling up open pull requests that conflict with
each other. A factory that wants more work in progress raises `maxConcurrent`.

Who handles a failed merge: the server decides and performs the merge, and never asks an agent
whether to merge. A failure that is code (a conflict, checks red on the updated base) is the
implementer's follow-up (D9). A failure that is not (the App lost a permission, a branch rule
refuses the merge, the branch was rewritten, GitHub answers an error after the provider's
retries) parks the run in `waiting_human` with the reason; no agent is started for it.

_Alternative:_ a dedicated lane table with a head slot. Rejected once the engine has
concurrency groups: it would be a second mechanism for the same rule.

`factory-integration` turns this lane into funny's own merge queue: the group gets
`batch: { max, wait }` (`workflow-dag-engine` D5b), the "otherwise" mode becomes a batch tested on
a temporary branch with bisection on red, and conflicts go through its `integrate` step before
`address`. With `batch.max: 1` the behaviour is the one described here, so this change can ship
first.

### D13. Stage limits: the flow declares, the factory tunes

Every agent node of the built-ins declares a group scoped to the factory:
`<node>:{{inputs.factory_id}}` (the factory passes `factory_id` as an input). The flow sets the
default limit; `factory_settings.stage_limits` (`{ [nodeId]: limit }`, saved with `steer`, shown
next to the step overrides of `factory-flow-step-options`) replaces it through `resolveLimit`.
The `merge` group is not tunable (D8). `maxConcurrent` keeps its meaning, runs in flight, and
bounds how many runs the watcher admits; stage limits decide how many of them are inside each
node at once (for example 3 implementing, 1 reviewing).

### D9. Integration conflicts

update-branch refusing with a conflict, or the merge queue reporting one: the server first tries
known-shape resolvers, which work on the server through the contents API and only for
whole-file regeneration it can do without running code: none in v1 for lockfiles (regeneration
needs a checkout), so lockfile and numbered-migration conflicts go to the implementer with a
specific instruction ("regenerate the lockfile", "renumber your migration after #N's"). Every
conflict follow-up carries the diff of the pull request that merged first. The implementer
merges the default branch in; the prompt forbids rebase and force push, and the server rejects a
head SHA whose history no longer contains the previously reviewed commit (a force push) by
parking the run.

This is the v1 behaviour. `factory-integration` puts a deterministic `integrate` step in front of
it: the run's worktree merges the base in with a structural merge driver and `rerere`, and
regenerates the paths `.funny/integrate.yaml` declares (lockfiles, migrations) with the
declared command; only a conflict left after that reaches the implementer, with the same
feedback as above.

### D10. The sentinel

Per factory, the watcher records the default branch's check state after each factory merge.
When the default branch's head (or the merge commit) turns red within 24 h of a factory merge,
the server opens an incident (one at a time per repository and base branch, compare-and-set),
pauses admissions of every factory on that repository (`blockedReason: incident #N`), and starts
a sentinel thread on the enabler of the most recent factory merge, with every factory merge
since the last green commit as candidates. Result `revert` with a culprit → the server opens a
revert pull request for the culprit (GitHub's revert-pull-request API; when unavailable, the
incident escalates) and notifies the culprit run's enabler; `escalate` / `unknown` → Web Push
to every affected enabler. The incident closes, and admissions resume, when the default branch
is green again. Reverts are not auto-merged (Non-Goals).

### D11. State machines

Run states gain `triaging`, `needs_info` (parked, no slot), `reviewing` and `merging`;
`QUEUE_TRANSITIONS` gains `needs_info → queued` (re-triage) and `triaging → queued` (path
hold). The incident is a new explicit machine with compare-and-set writers,
added to `docs/architecture/state-machines.md`.

### D12. App permissions

The manifest's default permissions become their own set (today they are
`SANDBOX_PERMISSIONS.write`) with `statuses: write`. Sandbox tokens stay capped at
`SANDBOX_PERMISSIONS`. An installation that has not accepted the new permission gets review
comments only; the factory settings show "accept the new App permission to publish
`funny/review`".

### D14. Two phases

Phase 1 is the reviewer and the merge lane: structured review results, the `reviewing` /
`merging` states, the test-weakening check and risk class, the review gate (D7), the merge group
and conflict handling (D8, D9) and stage limits (D13). It answers both problems in the proposal
and is deployable alone: there is no contract, so the reviewer judges against the issue, risk
hints are empty and no run reserves paths.

Phase 2 is triage and the contract (D4), path reservation (D5) and the sentinel (D10). They come
second because each one improves on something phase 1 already makes safe: reservation only
saves conflict work that the lane would catch, and the sentinel only fires when a change is
green on the current base and still breaks it.

The spec delta describes the end state; the change is archived after phase 2.

_Alternative:_ two changes. Rejected: the requirements share the role and result rules, and
`factory-integration` already refers to this change's groups.

## Risks / Trade-offs

- [The reviewer is also an LLM; a prompt injection in the issue or the diff can make it say
  `pass`] → It is defense in depth: CI on the current base, the deterministic risk class (which
  the LLM cannot lower) and branch rules still apply; high risk always waits for a person.
- [Review rounds and update-branch cycles make runs slower and costlier] → the review overlaps
  CI (D7), the loop limits, the merge group holds one candidate only while it waits on CI, and
  `issue-to-pr` remains for teams that merge by hand. Record per factory the review verdicts and
  the reasons runs park in `waiting_human`, so a team can see whether the reviewer pays and
  whether the risk rules (400 lines, sensitive paths) park too much to stay unattended.
- [An early review is wasted when CI rejects the commit] → it is stopped as soon as the head
  commit changes, it never takes a slot from a run already at the `review` node (it starts only
  on a free slot), and `early: false` turns it off.
- [A serialized lane is slow when CI is slow] → It is the batch of one of `factory-integration`'s
  merge queue, which tests and merges several pull requests per CI run and bisects a red batch.
- [`likely_paths` can be wrong] → Reservation is a soft hold; the merge lane still tests every
  candidate on the current base.
- [Pausing every factory on a repository on any red default branch can stall work for flaky
  checks] → Only red within 24 h of a factory merge opens an incident, and a green run closes
  it; a member can close an incident by hand.
- [`merge` behaviour changes for existing repository flows] → Repository copies of
  `issue-to-merge` without a `review` step park in `waiting_human` until they add one or set
  `require_review: false`; Validate flow (step-options) warns about it.

## Migration Plan

1. Migration: new run states, contract / verdict / risk columns on `factory_runs`, the incident
   table, `factory_settings.stage_limits`, `factory_settings.auto_merge` and `sensitive_paths`.
2. Phase 1: ship structured results and the review step with `merge` still in its old behaviour
   behind `require_review: false` in the built-ins; then flip the built-ins to the gate.
3. Phase 1: ship the merge group and conflict handling.
4. Update the App manifest permission; installations accept it at their pace.
5. Phase 2: triage and the contract, path reservation, then the sentinel.
   Rollback: the built-ins can set `require_review: false` and the merge group can be removed from the
   built-ins; new columns are nullable.

## Open Questions

- The exact per-language patterns of the test-weakening check beyond TypeScript / JavaScript
  and Python (more can be added without changing the spec).
- Default sensitive-path list contents beyond the ones above.
- Whether a conflict should go to a new thread instead of the implementer's when that thread is
  long (it would get the contract, the pull request's diff and the diff that merged first).
  Decide from phase 1 data; it would relax "one writer thread per branch" to "one writer at a
  time".
