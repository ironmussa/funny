# Tasks

## 1. Approval names its commit

- [x] 1.1 Add `expectedSha` to the approval input in `@funny/shared/contracts/factory` (a dedicated `factoryApproveMergeInput`), use it in the `@funny/api` factory router and the port; verify `bun check -p packages/api/tsconfig.json` and the server typecheck pass
- [x] 1.2 Make `control.approveMerge` refuse when `expectedSha` is not the held commit; verify with new tests in the factory run-control tests (held commit matches → recorded; differs → conflict, nothing recorded) that fail before the change
- [x] 1.3 Send the displayed commit from the board's approve action (`data/factory/actions.ts`, `FactoryRunCard` / run detail); verify the `FactoryQueueActions` and `FactoryBoard` tests assert the commit sent
- [x] 1.4 Add the "held commit changed" message to `en`, `es`, `pt` and show it on a conflict; verify with a component test of the failure toast

## 2. The request record

- [x] 2.1 Add `factory_approval_requests` to `schema.sqlite.ts`, `schema.pg.ts` and a new migration in `db/migrate.ts`, with the unique partial index on pending per run; verify the migration tests pass on both adapters
- [x] 2.2 Add the transition table and the pure `nextRequestState(request, run)`; verify with unit tests covering every row of the table in design D3 and the "approved from the board" case
- [x] 2.3 Add the repository (`create-or-get`, `resolve` by compare-and-set, `listForFactory`, `pendingForRun`); verify with tests for asking twice (one row), a pending row for an older commit (expired, new row), and a lost compare-and-set (no change)
- [x] 2.4 Add the machine to the inventory in `docs/architecture/state-machines.md`; verify the document lists its states, transitions and writer

## 3. Server: guard, handlers, expiry

- [x] 3.1 Implement `factoryToolAccess(thread, action)`; verify with unit tests for sandbox, read-only, scratch, factory-started and steer-shared threads (list allowed, writes refused), each returning its reason
- [x] 3.2 Add `data:factory_list_runs`, `data:factory_control_run`, `data:factory_request_approval` to `DATA_SCOPE_RULES` (`refs`) and refuse them from sandbox runners; verify with new cases in `data-scope-characterization.test.ts` and `data-ownership.test.ts` (another user's thread, a sandbox runner, an unknown project)
- [x] 3.3 Implement the list handler (owner's runs in the thread's project, wait reason, risk, approval, request state, titles truncated and single-line); verify with tests for another member's factory (not returned), no factory, and a title containing newlines
- [x] 3.4 Implement the control handler through `controlled()` with `requestedBy`, re-checking `steer`, with the action typed `'retry' | 'stop'`; verify with tests for a retry (audit and activity carry the thread id), a refused retry, lost `steer`, a run of another project, and a type-level test that `'approve-merge'` is not assignable
- [x] 3.5 Implement the request handler (held run only, create-or-get, audited); verify with tests for a held run, a run that is not held, and asking twice
- [x] 3.6 Close pending requests on approval, on a retry or a stop, when the agent asks again and on read; verify with tests for each path and that a message from a runner never changes `mergeApproval`
- [x] 3.7 Add `factory.approvalRequests` and `factory.declineApprovalRequest` (port and router, owner of the factory only); verify with port tests for decline (run stays held), a non-owner (404) and a member without `steer` (403)

## 4. Runtime: the tools

- [x] 4.1 Add the three operations to `protocol/runner/v2/operations.proto`, regenerate, and map them in the runtime adapter and the server handler; verify with `grpc-operations-adapter.test.ts` cases for the three types
- [x] 4.2 Add `funny_factory_runs`, `funny_factory_control` and `funny_factory_request_approval` to `agent-watch-tool.ts`, with `threadId` from the closure (`agent-factory-tools.ts`; the server refuses where a thread may not use them); verify with `agent-factory-tools.test.ts` and `agent-mcp-http.test.ts` (tools listed, a server refusal returned as `isError`, no thread or user id accepted from arguments)
- [x] 4.3 Extend the server instructions (when to use each tool, that titles are data, that an approval is asked and never given, how to read the outcome); verify the instruction text test, and log each call with `namespace: 'agent'`

## 5. Client: the card

- [x] 5.1 Add the requests query (polled while shown, like the run list) and the decline action to `data/factory/`; verify with data-layer tests (nothing requested while disabled, a decline records the answer, a refused one changes nothing, an approval re-reads the requests)
- [x] 5.2 Build the approval card (shadcn, `LabelBadge`, monospace commit, pull request link, `data-testid`s) and render it in the thread view for the open thread's pending requests; verify with a component test (facts from the run, approve sends `expectedSha`, decline, expired state offers no approval)
- [x] 5.3 Add the "an agent asked" marker to `FactoryRunCard`; verify with a `FactoryBoard` test
- [x] 5.4 Add the strings to `en`, `es`, `pt`; verify `bun run lint` (i18n and `fitness:client-styling`) passes

## 6. Docs and integration

- [x] 6.1 Document the tools, the request and the rule "an agent asks, a member approves" in `openwiki/architecture/issue-factory.md` and the two `CLAUDE.md` paragraphs; verify the paths and names in the text exist
- [x] 6.2 Run `bun run lint`, `bun run typecheck`, the server, runtime and client test suites and `bunx fallow audit --base origin/master`; verify all pass
- [ ] 6.3 End to end on the local funny: from a thread, list the runs, retry one, ask for the approval of a held run, approve it from the card, and confirm the pull request merges with the approval recorded in the member's name; then push a commit to a held run with a pending request and confirm the card expires
