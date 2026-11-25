# Proposal

## Why

An agent in a thread cannot see or act on the issue factory. The factory's controls are tRPC procedures that accept only a browser session, and the public API (`/api/v1`) has no factory endpoints, so a member who works from a thread has to leave it and click through the board for every run. On 2026-11-24 ten approved runs waited for a retry that the agent helping with them could describe but not perform.

Giving the agent the board's controls as they are would also give it the merge approval, and with it every prompt injection that reaches the agent. This change gives the agent the controls that are safe to delegate, and a way to ask the member for the one that is not.

## What Changes

- Three new tools in the `funny` MCP server, for a thread in a project:
  - `funny_factory_runs` lists the thread owner's factory runs in the thread's project: issue number, pull request, state, why a run waits, its risk class and whether its head commit is approved.
  - `funny_factory_control` retries or stops one run, as the thread owner, through the same use case as the board. It needs the owner's `steer` on the project, is audited and shown in the owner's activities, and records the thread that asked.
  - `funny_factory_request_approval` asks the member to approve merging a held high-risk change. It never approves.
- A merge approval request is a server record bound to one run and one commit. It appears as a card in the thread that asked and on the run's card on the board, with facts the server computed (commit, size, risk reasons, pull request link), never text the agent wrote.
- The member answers the card with their own browser session, through the existing `factory.approveMerge`. Nothing sent over the runner's data channel or the MCP server counts as an approval.
- `factory.approveMerge` takes the commit the member saw (`expectedSha`) and refuses when the run's held commit is another one. The board sends it too.
- A request ends when the member approves or declines it, when the run's held commit changes, or when the run stops waiting for an approval. The agent reads the outcome from `funny_factory_runs`.
- The tools are refused in sandbox threads, read-only threads, scratch threads and the factory's own threads. `funny_factory_control` and `funny_factory_request_approval` are also refused in a thread shared at `steer`.

## Capabilities

### New Capabilities

- `factory-agent-tools`: what an agent in a thread may read and do on the thread owner's issue factory, and how it asks the member for a merge approval.

### Modified Capabilities

- `issue-factory`: a merge approval names the commit the member saw and is refused for any other commit.

## Impact

- **Runtime**: `packages/runtime/src/services/agent-watch-tool.ts` (the three tools), a new data-channel client next to `remote-thread-data-client.ts`.
- **Server**: three new `data:*` types with rules in `DATA_SCOPE_RULES` and handlers in `data-message-handlers.ts`; a new `factory_approval_requests` table (migration, sqlite and pg schema, repository in `packages/shared`); `factory-run-control.ts` (`expectedSha`, closing a request on approval); `trpc/ports/factory.ts`; three new operations in the runner protocol (`protocol/runner/v2/operations.proto`, generated TypeScript and Rust).
- **API**: `@funny/shared/contracts/factory` (`expectedSha` on the approval input, the request type), `@funny/api` factory router (`approvalRequests`, `declineApprovalRequest`).
- **Client**: `data/factory/` (requests collection, realtime apply), a card in the thread view and a marker on `FactoryRunCard`; i18n in `en`, `es`, `pt`.
- **Depends on** `factory-approval-survives-integration` (the approval record and its moves), which is on `master` and not archived yet.
- **Docs**: `openwiki/architecture/issue-factory.md`, `CLAUDE.md` (the tRPC paragraph and the factory service paragraph).
