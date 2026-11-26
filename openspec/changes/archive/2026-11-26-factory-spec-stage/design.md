# Design

## Context

See proposal.md — Why. The pieces this builds on (all in `packages/server/src/services/factory/`
unless noted):

- **Triage** (`factory-triage.ts`): a read-only role thread whose last `json` block is validated
  by `factoryTriageResultSchema` (`@funny/shared/contracts/factory`) through `readRoleResult`
  (`factory-role-results.ts`: one re-emit request, then the role's failure rule). The stored
  answer is `factory_runs.triage` (`factoryTriageSchema`); a stored, non-superseded answer is
  replayed instead of triaging again.
- **Run states** (`factory-runs.ts`): `FLOW_TRANSITIONS` / `QUEUE_TRANSITIONS`, every write a
  compare-and-set. `needs_info` is written only from `triaging`, leaves through `retriage`
  (`needs_info → requested`), `hold`, or stop. Parked runs hold no slot.
- **Role threads**: `readOnlyRoleLaunch` / `launchedThread` (`factory-review.ts`) start a
  read-only thread on the enabler's runtime with `roleInputs` (issue text written outside the
  checkout, never inlined); `releaseRoleWorkspace` removes its worktree once the answer is
  stored.
- **Thread terminal events**: `onFactoryThreadTerminal` (`factory-run-control.ts`) is called
  when the runner persists a terminal status; today it wakes waiting steps and handles the
  owner's take-over of the implementing thread only.
- **Merge approval** (`factory-approval-requests.ts`, `factory-runs-approvals.ts`): an agent
  asks through `funny_factory_request_approval`; a member approves from the browser naming
  `expectedSha`; nothing on the runner's data channel reaches the approval.

## Goals / Non-Goals

**Goals:**

- One extra parked state and one extra read-only role, reusing the role-thread, role-result,
  approval and compare-and-set machinery as they are.
- The spec conversation happens in an ordinary funny thread, so answering is "reply in the
  thread", with no new chat UI.
- The approved spec is data the server owns and injects; agents never read each other's threads.

**Non-Goals:**

- A spec stage for runs without an issue (schedule / run_now): they have no triage.
- Editing a draft by hand in the UI. A member changes a draft by telling the spec writer.
- Specs as a flow node (`spec: {}` in YAML). It hangs off triage's answer, like `needs_info`;
  a flow node can come later if repositories want to place it.
- Expiring idle `needs_spec` runs. Hold and Stop already exist.

## Decisions

### D1. `needs_spec` is a triage answer, not a flow step

Triage already decides "can this run unattended". Adding the answer there keeps both built-in
flows unchanged and lets one setting turn the stage on for any flow with a `triage` step.
_Alternative:_ a `spec` node between `triage` and `implement`. Rejected for now: every
repository flow would need editing, and the node would sit in an in-memory flow for hours or
days while a person answers, which the flow engine is not built for (parked runs have no
running flow; resume replays recorded threads).

The answer carries `decisions: { question, options? }[]` (1–10) and `findings` (what triage
learned in the code, ≤10 lines), both handed to the spec writer as role inputs.

When the Spec stage is off, the triage prompt does not list `needs_spec` and the server's schema
refuses it (it becomes an invalid result → one re-emit request), so a factory never parks on an
answer it did not opt into.

### D2. A new parked state, `needs_spec`

`needs_spec` joins `FactoryRunState` with the same shape as `needs_info`: written only from
`triaging` (`FLOW_TRANSITIONS`), no slot, holdable (`FACTORY_RUN_HOLDABLE_STATES`), stoppable.
It leaves by:

- `approveSpec`: `needs_spec → requested` (new `QUEUE_TRANSITIONS` entry), keeping the run's
  `queue_order` (earlier than anything sent after it, so it goes first);
- `retriage`: now from `needs_info` or `needs_spec` (a member chose "Triage again");
- `hold` / stop, as today.

`reopenSpec` writes `needs_spec` from `requested` (approved, not admitted yet) and from the
parked states (`waiting_human`, `failed`, `no_change`,
`stopped`), each a compare-and-set. It is refused while the run is in flight; stop it first.
The table and the state-machines doc row are updated together, with the table tests (every
legal transition, one illegal per state).

_Alternative:_ reuse `needs_info` with a sub-reason. Rejected: the board line, the re-triage
rule (issue changed → triage again) and the actions all differ, and a sub-reason would be a
second state hidden in a field.

### D3. The spec writer is a read-only role thread with a multi-turn conversation

Launched by the server right after storing the `needs_spec` answer, via `readOnlyRoleLaunch`,
title `[Factory spec] #N <title>` (adoption by title on resume, like triage), `roleInputs`:
issue text, triage's decisions and findings, and on reopen the previous approved spec. Its
worktree is **kept** while the run is `needs_spec` (the writer reads code across turns) and
released on approval, retriage, hold or stop. Recorded on the run as `spec.threadId`, and added
to `threadsOf` so stop and cleanup reach it.

Members answer by following up on that thread. The thread's owner is the enabler, so the
existing follow-up path works unchanged. A follow-up on a role thread never takes the run over
(`onFactoryThreadTerminal` already acts only on the implementing thread).

Each completed turn of the spec thread is handled in `onFactoryThreadTerminal`: when the thread
is a run's `spec.threadId` and the run is `needs_spec`, `factory-spec.ts` reads the result with
`readRoleResult(factorySpecResultSchema, …)` and stores it (D4). No flow is running; the event
is the trigger. A turn that ends without a result after the re-emit request stores
`spec.problem = 'no valid result'` and leaves the run parked.

The same `quietAnswerMs` rule as other role threads applies (a turn whose answer is followed by
nothing for 10 minutes is stopped and read).

_Alternative:_ continue triage's thread. It has the research context, but triage's worktree is
released on answer, and the role contract says one role, one thread. Triage's findings passed as
input recover most of the context at a small token cost.

### D4. Results and storage

`factorySpecResultSchema` (shared contracts):

```ts
z.discriminatedUnion('status', [
  z.object({ status: z.literal('questions'),
             questions: z.array(z.object({ question, options: z.array(line).max(6).default([]) })).min(1).max(10) }),
  z.object({ status: z.literal('draft'), spec: factorySpecSchema }),
])
factorySpecSchema = { summary, decisions: {question, answer}[], behavior: line[], approach: line[],
                      outOfScope: line[], validation: line[] (min 1, max 20), contract: factoryContractSchema }
```

Stored on the run as `factory_runs.spec` (JSON, migration): `{ threadId, latest: result,
latestAt, revision, problem?, approved?: { spec, revision, by, at } }`. `revision` increments on
every stored result; approval names it (D5). The draft text is agent output: it is shown escaped
in the UI and handed to later agents as role input, never inlined in a server-built prompt line
without the existing templating.

### D5. Approval mirrors merge approval

`factory.approveSpec({ runId, revision })` on the `factory` tRPC group, `steer` on the project,
browser session only (the procedure is not reachable from the runner's data channel or the
factory MCP tools). One compare-and-set writes `spec.approved`, `triage = { decision: 'ready',
contract: spec.contract, at, fromSpec: true }` and `state = 'requested'` `WHERE state =
'needs_spec' AND spec.revision = :revision`; zero rows → 409 with the current run. An audit
record and a `factory.spec_approved` activity are written.

Agents get `funny_factory_request_approval` extended: on a `needs_spec` run with a draft it
creates an approval request of kind `spec` for that revision (a card in the thread and on the
board), answered by the member through `approveSpec`. Expires when the revision changes, like a
merge request expires when the head moves.

Triage replays the stored `fromSpec` answer and never treats it as superseded by issue edits
(`issueChangedSince` skips it), which is the "not discarded when the issue changes" rule.

### D6. The implementer and the reviewer

- `implement.md` gains a `{{#spec}}…{{/spec}}` section rendering the approved spec (decisions,
  behavior, approach, out of scope, validation) and the rule: decisions in the spec are fixed,
  open choices are decided and listed under **Decisions** in the pull request. With
  `commitSpecPath` set (e.g. `docs/specs/`), it adds "commit the spec as
  `<path>/issue-<n>.md`". The template variable is filled by the action provider from the
  stored approval, so repository flows that use `implement.md`-style prompts can opt in with
  `{{spec}}`; Validate flow warns when the Spec stage is on and the flow's first agent prompt
  never uses it.
- `factoryReviewResultSchema` gains optional `checklist: { item, met, note? }[]`. For a run with
  an approved spec, the reviewer prompt lists the validation items and requires the checklist;
  `readRoleResult`'s validation is given a refinement that every item is answered (unanswered →
  invalid → one re-emit). The server then appends a `high` finding per unmet item before
  `reviewAllowsMerge` runs, so the existing loop-back handles it. The PR review comment lists
  the checklist.

### D7. Settings

`factory_settings.spec_stage` (boolean, default false) and `commit_spec_path` (nullable text,
validated as a relative path without `..`), saved with `steer`, shown in **Settings > project >
Factory** with `SettingRow` entries indexed in `settings-index.ts`.

### D8. Client

- `run-state-chip.ts` / `board-columns.ts`: `needs_spec → needs_person`, own label and tone.
- Card "why waiting": `factory-run-labels.ts` (`N open questions` / `spec waits for approval`).
- Run panel: a Spec section — questions with a link to the spec thread, or the draft rendered
  with Approve (`data/factory/actions.ts`, optimistic: no, the UI waits on the 409 check) and
  Reopen spec, or the approved spec with who/when.
- `data-testid`s: `factory-spec-approve`, `factory-spec-reopen`, `factory-spec-thread-link`.

## Risks / Trade-offs

- **[Runs parked for days]** A `needs_spec` run may wait indefinitely. → It holds no slot; the
  board shows it under Needs a person; Hold and Stop apply. Its kept worktree costs disk: released
  on hold/stop, and the factory's existing orphan cleanup covers crashes.
- **[Triage over-uses `needs_spec`]** Every issue becomes a conversation. → The prompt defines it
  narrowly (a product decision a wrong guess would waste, not a technical one the code answers),
  the setting is off by default, and analytics count `needs_spec` answers per factory
  (`triage_decision` metric gains the value) to tune the prompt.
- **[Prompt injection through the issue reaches the spec]** The spec writer reads the issue. →
  It is read-only, its result is validated data, and a member must approve the exact revision
  before anything implements it; the approval is the trust boundary, as for merges.
- **[Answers by a steer sharee of the spec thread]** A sharee can steer the conversation. →
  Approval still needs `steer` on the project from a browser session; the draft shown is what is
  approved.
- **[Reviewer checklist adds a failure mode]** A reviewer that skips items fails closed after one
  re-emit. → Same rule as a missing verdict; the board shows `review gave no verdict`.

## Migration Plan

One additive migration: `factory_runs.spec` (nullable JSON), `factory_settings.spec_stage`
(default 0), `factory_settings.commit_spec_path` (nullable). No backfill. Default off means no
behavior change on deploy. Rollback: turn the setting off; runs already in `needs_spec` can be
retriaged or stopped. Server and client deploy together (new state value); an older client
shows `needs_spec` in Needs a person by the unknown-state rule.
