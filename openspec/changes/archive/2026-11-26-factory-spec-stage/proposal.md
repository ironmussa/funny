# Proposal

## Why

Triage tells an issue that can be worked unattended (`ready`) from one that lacks facts
(`needs_info`), but not from one that is clear and still leaves **product decisions** open:
where an affordance lives, what it applies to, what happens at its edges. Today such an issue
goes `ready`, and the implementer, told "make reasonable decisions", decides them alone. The
pull request works and is still the wrong change, and the person learns that only when reviewing
the code. Asking on the issue (`needs_info`) does not fit either: those decisions belong to the
team that runs the factory, not to the issue's author, and a conversation through issue edits
and re-triage is slow. (Prompted by Warp's "How to build a software factory you'll actually use",
which adds a spec stage between triage and implementation.)

## What Changes

- Triage gains a fifth answer, `needs_spec`: the issue is workable, but it has open product
  decisions a wrong guess would waste. Offered only when the factory's new **Spec stage**
  setting is on (off by default).
- On `needs_spec` the run parks in a new state `needs_spec` (no concurrency slot) and the server
  starts a **spec writer**: a fifth read-only role, on its own thread on the enabler's runtime.
  It asks its questions in that thread; members answer there, in funny, not on the issue.
- Every turn of the spec writer ends with a validated result: more questions, or a **spec
  draft** (summary, decisions taken with their answers, product behavior, technical approach,
  out of scope, validation checklist, and the run's contract). The latest draft is stored on
  the run and shown on its card and panel.
- A member with `steer` **approves** a draft from their browser session, pinned to the draft
  shown. Approval stores the spec, writes the run's contract from it and sends the run back to
  the queue, keeping its place. No agent can approve a spec; an agent can ask for it.
- The implementer's first prompt carries the approved spec: its decisions are not the agent's
  to change, and only choices the spec leaves open are decided and stated in the pull request.
  With the factory's **Commit spec** setting, the implementer also commits it to a given path.
- The reviewer receives the spec and answers each validation item (met / not met). A missing
  item makes the result invalid; an unmet item counts as a `high` finding, so it loops back to
  the implementer like any high finding.
- The board shows `needs_spec` runs in **Needs a person** with what they wait for (N open
  questions, or a draft to approve) and the Approve action; the run panel shows the draft.
- `funny_factory_run` returns the spec; `funny_factory_request_approval`-style asking extends
  to specs (an agent asks, the member approves on a card).

## Capabilities

### New Capabilities

- `factory-spec`: the spec writer's conversation, its stored result, approval of a spec, and how
  an approved spec reaches the implementer and the reviewer.

### Modified Capabilities

- `issue-factory`: triage gains the `needs_spec` answer; the roles requirement gains the spec
  writer; the review judges a run with a spec against its validation checklist.
- `factory-pipeline-board`: the `needs_spec` state's column and its "why waiting" line.

## Impact

- **Shared:** `@funny/shared/contracts/factory` (triage result union, new spec result and stored
  spec schemas, run state `needs_spec`, review result checklist, settings `specStage`,
  `commitSpecPath`).
- **Server:** `services/factory/` — triage (prompt and answer handling), a new
  `factory-spec.ts` (spec writer launch, turn handling, approval), `factory-runs.ts`
  (`needs_spec` in `FLOW_TRANSITIONS` / queue transitions, approval compare-and-set),
  `factory-review.ts` (spec in prompt, checklist rule), `factory-run-control.ts` (spec thread
  terminal events), `factory-agent-tools.ts`, the `factory` tRPC port; one migration (stored
  spec and approval on `factory_runs`, the settings columns).
- **Workflows:** `prompts/implement.md` (spec section); built-in flows unchanged otherwise.
- **Client:** factory board column and card line, run panel spec section with Approve, the
  spec-writer thread link, settings rows (indexed in `settings-index.ts`), translations.
- **Docs:** `openwiki/architecture/issue-factory.md`, `docs/architecture/state-machines.md`.
