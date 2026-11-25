# Design

## Context

See proposal.md for the motivation. What shapes the approach:

- The `funny` MCP server runs in the runner (`agent-watch-tool.ts`, served by `agent-mcp-http.ts`). Its handlers get `threadId` and `userId` from the spawn's token grant, never from the model.
- The runner has no database. A tool that needs server state sends a `data:*` message over the gRPC data channel (`funny_search_threads` → `data:search_threads`). Every type needs a rule in `DATA_SCOPE_RULES`; unknown types are refused.
- The factory's controls live in `createFactoryRunControl` (`factory-run-control.ts`), wrapped by `controlled()` in `trpc/ports/factory.ts`, which resolves the caller's own factory, audits and writes the activity.
- `approveMerge` approves `run.risk.headSha` as it is at the moment of the call. The caller does not say which commit they saw.
- A runner is the member's own machine, but what the agent does on it is not always the member's intent: issue text, pull request content and tool output can carry instructions.

## Goals / Non-Goals

**Goals:**

- An agent can list, retry and stop runs with no more authority than the thread owner has on the board.
- A merge approval can only come from a browser session of the factory's owner, for a commit that was on screen.
- One implementation of each control: the tools call the same use cases as the board.

**Non-Goals:**

- Approving a merge from an agent, a personal API token, or the public API.
- Factory settings, sending issues, triggers, clearing the queue, stopping all runs, closing an incident. They stay on the board.
- Runs of other projects than the thread's.
- A push or email notification for a request, and a realtime event for it. The card and the board marker are the surfaces in this change, and they poll.
- Waking the thread when the member answers.

## Decisions

### D1. Three data-channel types, authorized on the server from the thread

`data:factory_list_runs`, `data:factory_control_run` and `data:factory_request_approval`, each carrying the `threadId` from the tool's closure, with rule `refs` so the existing scope check ties the message to a thread the sending runner serves. The handler then loads the thread row and derives everything else from it: the actor is `threads.user_id`, the project is `threads.project_id`, and the factory is that member's factory in that project (`ownFactory`). The message's own `userId`, if any, is ignored.

One server-side guard, `factoryToolAccess(thread, action)`, decides the refusals of the spec in one place: sandbox runtime, `read_only`, scratch, a thread listed in a factory run's `threadIds` (or created with the factory's source), and for the two writing actions, a live `steer` share on the thread. Sandbox runners are also refused by type, in a set like `SANDBOX_ONLY_TYPES` but inverted (`NEVER_FROM_SANDBOX_TYPES`).

_Alternative: a tRPC call from the runner with a personal API token._ Rejected: it would put a long-lived credential on the runner, and the token would also reach `approveMerge` unless every procedure learned a second authentication kind.

_Alternative: gate in the runner (do not register the tools in some threads)._ Rejected: the tool list is built from the spawn's grant, which holds no thread row, and the runner's code is not a boundary anyway. The tools are always listed and the server answers a refusal the agent can read.

The runner's protocol is protobuf (`protocol/runner/v2/operations.proto`), so the three types are three new operations (`FactoryListRuns`, `FactoryControlRun`, `FactoryRequestApproval`, fields 90 to 92) with generated code for TypeScript and Rust.

### D2. Retry and stop reuse `controlled()`, with the asking thread recorded

The port's `controlled(action, userId, projectId, runId)` gains an optional `requestedBy: { threadId }`. The data-channel handler calls it with the thread owner as `userId` after re-checking `steer` with `decideProjectAccess` (the same decision as `projectProcedure('steer')`). The audit record and the activity row carry the thread id, so the member sees "retried from thread …". `approve-merge` is not reachable from the handler: the handler's action type is `'retry' | 'stop'`, not `RunControlAction`.

_Alternative: ask the member to confirm each retry or stop._ Rejected for now: both are reversible (a stopped run can be retried, a retried run can be stopped), both are already what a `steer` member's agent can cause indirectly, and each leaves a trace. The merge approval is the one irreversible step.

### D3. A request is a stored state machine

New table `factory_approval_requests`: `id`, `run_id`, `factory_id`, `project_id`, `thread_id` (the asking thread), `sha`, `state`, `created_at`, `resolved_at`, `resolved_by`. States and transitions, declared in one table and written with compare-and-set (`UPDATE … WHERE id = ? AND state = 'pending'`, row count checked):

| From      | To         | When                                                                                |
| --------- | ---------- | ----------------------------------------------------------------------------------- |
| `pending` | `approved` | the run's merge approval is recorded for `sha`                                      |
| `pending` | `declined` | the owner declines the card                                                         |
| `pending` | `expired`  | the run is held on another commit, or leaves the high-risk hold without an approval |

A unique partial index on `(run_id)` where `state = 'pending'` makes "asking twice" return the existing row (insert, on conflict read). If the pending row is for an older commit, the insert path expires it first, in the same transaction.

The facts on the card are not stored in the row. The card reads the run (`FactoryRunView`: `risk.reasons`, `risk.headSha`, size, `prUrl`) through the factory queries, so it cannot show anything the agent chose and never goes stale against the run.

_Alternative: reuse the pipeline approval plumbing (`data/approvals`, `pipeline:approval_requested`)._ Rejected: that is an in-memory gate of a pipeline run answered through a pipeline route, and its payload is written by the pipeline. Reusing it would mean a second way to approve a merge. The dialog's look can be reused; the mechanism is not.

_Alternative: MCP elicitation._ Rejected: the party that answers an elicitation is the agent's MCP client, which in funny is the agent process with no person attached.

_Alternative: no record, only an event that makes the client show the run's existing approve button._ Rejected: nothing would survive a reload, the agent could not read the outcome, and declining would have no meaning.

### D4. Approval stays on `factory.approveMerge`, which now takes `expectedSha`

`factoryRunInput` for the approval becomes `{ projectId, runId, expectedSha }`. `control.approveMerge` refuses with a conflict when `expectedSha !== run.risk.headSha`. The repository's compare-and-set (`runs.approveMerge`) conditions on the hold (state and reason). It does not condition on the held commit: the risk is a JSON column, and a run's risk is only rewritten while the run is in flight, which the hold condition already excludes. After a successful approval, `controlled()` brings the run's pending request in line with the run (`requests.sync`), and so does every read: "the run has an approval for `sha`" reads as approved, not expired.

The card's Approve button calls this procedure with the card's commit. There is no "approve request" procedure: a request is never the thing approved. `factory.declineApprovalRequest({ projectId, requestId })` (`steer`, owner of the factory only) is the only new mutation.

`expectedSha` is required, not optional, so no client can approve blind. The only callers are the web client's board and the new card.

### D5. A request is brought in line with its run on read and on every control

One pure function, `nextRequestState(request, run)`, decides. It runs:

- after an approval, a retry or a stop (the board's or an agent's),
- when an agent asks again (a pending request for an older commit expires first), and
- whenever requests are read: the list port, and `data:factory_list_runs`.

The flow's own writers (a new risk classification, leaving the hold) do not call it. Nobody can see a request without a read, a stale card's approval is refused by D4, and hooking every writer of a run would spread the rule.

_Alternative: a timer._ Rejected: a request has no deadline of its own, only the commit's.

### D6. The tool returns at once

`funny_factory_request_approval` creates (or finds) the request and returns its id and state. The agent learns the outcome from `funny_factory_runs`, and can schedule that check with `funny_watch`. The tool's description says so.

_Alternative: block until the member answers._ Rejected: a member may answer hours later, MCP calls time out, and a blocked call holds the agent's turn open and its process alive.

### D7. Client: a query, an event, a card

`factory.approvalRequests({ projectId })` returns the caller's own requests, newest first. The client reads it through `data/factory/` as a query, polled every 15 seconds while shown, like the run list (the factory sends no realtime events today). Only a thread of a project where the caller has a factory polls, and only a board card of a run that waits for an approval.

The thread view renders one card per pending request whose `threadId` is the open thread, after the factory run's own cards in the message stream. A closed request shows no card. `FactoryRunCard` shows a small marker ("an agent asked for your approval") next to its existing approve button. Both use shadcn components, `LabelBadge` for the risk class and state, monospace for the commit, and carry `data-testid`s (`factory-approval-card-{id}`, `factory-approval-approve-{id}`, `factory-approval-decline-{id}`).

The card is shown only to the factory's owner. A steer sharee viewing the thread sees nothing (the query is scoped by factory owner).

### D8. Tool output is data

`funny_factory_runs` returns a few lines per run: issue number, pull request URL, state, wait reason, risk and approval. A run row holds no issue title, so none is returned; review text, triage questions and issue bodies are not returned either. The failure reason and the risk reasons are cut to one line of 200 characters, and the server instructions say run fields are data to report.

## Risks / Trade-offs

- [A prompt injection makes the agent stop or retry runs] → Both are reversible and traced with the thread that asked; the tools are refused in the threads most exposed to foreign text (factory threads, sandboxes, steer-shared threads). If this proves too loose, D2's confirmation alternative can be added without changing the tools' shape.
- [Polling: an open thread of a project with a factory asks for the requests every 15 seconds] → One small query, the same cadence as the run list; a realtime event can replace it later without changing the record.
- [The agent floods the member with requests] → One pending request per run, and asking twice returns the existing one. A request for a run that is not held is refused.
- [The member approves because an agent asked, without reading] → The card shows the same facts as the board and links to the pull request; it says an agent asked. This does not remove the human factor, and the docs say so.
- [`expectedSha` breaks an old browser tab] → The tab's approval fails validation with a message asking to reload. No approval is recorded, which is the safe failure.
- [A missed transition leaves a stale pending request] → The read-time check of D5 expires it before anyone sees an Approve button for a commit that is no longer held, and D4 refuses the approval anyway.
- [Three more `data:*` types widen the data channel] → Each has a `refs` rule, a sandbox refusal and a characterization test in `data-scope-characterization.test.ts`.

## Migration Plan

1. Migration adds `factory_approval_requests` (sqlite and pg). No backfill.
2. Server and client deploy together (the board must send `expectedSha`). On Railway: server deploy, then runner deploy for the tools.
3. Rollback: revert the deploy. The table can stay; pending rows are ignored by the old code.

## Open Questions

- Whether a resolved request should stay in the thread as history. The first version shows pending requests only; the record keeps the rest.
