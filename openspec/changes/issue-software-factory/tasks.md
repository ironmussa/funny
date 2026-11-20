# Tasks

## 1. Shared building blocks (no behavior change in the server)

- [ ] 1.1 Create `packages/sandbox` (`@funny/sandbox`) and move the provider contract, registry, `poll`, shared JSON API, Boat, Instabox and fake providers there from `packages/server/src/services/thread-sandboxes/`; the server imports them from the package; verify with the server's existing sandbox tests unchanged and `bun run typecheck`
- [ ] 1.2 Move the runner install script, `runner-build` and the template manager into `@funny/sandbox`, with logging and metrics as injected ports; verify with the existing template-manager tests and a server boot type check
- [ ] 1.3 Generalize `CreateSandboxRequest.threadId` to an owner key (server passes the thread id); verify with provider tests for idempotency per key
- [ ] 1.4 Move the App JWT and installation token issuer to `packages/core/src/github-app/`, keeping the server's owner-access cap in the server; verify with the issuer tests moved alongside and the server's sandbox-token tests unchanged
- [ ] 1.5 Extract from `runtime/services/sandbox-github-auth.ts` a `@funny/core` helper that writes a token for `gh` and git into a given config directory; the runtime uses it; verify with a unit test on a temp directory and the runtime's existing tests

## 2. Orchestrator skeleton

- [ ] 2.1 Remove from `packages/agent` the Hono server, routes, Chat Completions developer agent, session store, ingest and review-event adapters, and the `issue-pipeline`, `ci-retry`, `review` and `merge` workflows with their tests; keep `trackers/`, `core/state-machine.ts`, `config/`, `infrastructure/` and the reviewer; verify `bun test` in the package
- [ ] 2.2 `factory.yaml` schema and loader (zod), with the refusal of secret-looking keys; verify with config tests for valid, missing-field, unknown-workspace and secret-in-file cases
- [ ] 2.3 Startup secrets from environment or TTY prompt, kept in memory, redacted from logs; verify with tests for missing secrets per configured project
- [ ] 2.4 `RunStore` on `bun:sqlite` (runs, daily counter) with migrations at open; verify with store tests on a temp file
- [ ] 2.5 `bin/orchestrator.ts` with `start` and `status`, and `dev:orchestrator` in the root `package.json` (not part of `bun run dev`); verify `status` prints an empty list on a new database

## 3. GitHub through the Factory App

- [ ] 3.1 `IssueSource` and `PullRequests` adapters over the existing GitHub tracker, using per-repository installation tokens; verify with tests against a fake GitHub API
- [ ] 3.2 Trusted text: only the configured login's issue body and comments are returned; verify with a test that drops another user's comment and an issue opened by someone else
- [ ] 3.3 Label bootstrap (ready, in-progress created when missing) and claim (assign, labels, comment); verify with fake-API tests including a claim that cannot be written
- [ ] 3.4 Report repositories without the App installed in `status`; verify with a fake-API test

## 4. Domain

- [ ] 4.1 `planAdmission` (label, author, assignee, blocked, one run per issue, concurrency over slot-holding states, daily limit, oldest first); verify with table tests for every scenario of "Ready issues are admitted"
- [ ] 4.2 Run state machine with slot-holding states, fix-attempt budget and retry with `notBefore`; verify with transition tests including exhausted attempts and infra retries
- [ ] 4.3 Prompt and pull request body builders (`Closes #N`, note when there are no local checks); verify with snapshot-free assertion tests

## 5. Workspaces and the step runner

- [ ] 5.1 `factory-issue.yaml` in `@funny/workflows` defaults (implement, checks with in-place fixes, commit with author, push, draft pull request against the base); verify with a parser test
- [ ] 5.2 `bin/sandbox-run.ts` with the `implement` and `fix` steps on `@funny/pipelines` and a workspace-local `ActionProvider`, writing events and an exit marker; verify with a test that runs it in a temp git repository with a fake agent
- [ ] 5.3 Worktree workspace: create, run `sandbox-run` as a child with a scrubbed environment and a per-run `GH_CONFIG_DIR`, destroy; verify the user's `gh` config is untouched in a test with a temp `HOME`
- [ ] 5.4 Sandbox workspace: template of the factory's commit, create without `sandbox.env`, write run secrets through `exec` to a root-only file, clone with the run token, start `sandbox-run` detached and read its events; verify with the fake provider
- [ ] 5.5 Token renewal: rewrite a run's token 5 minutes before expiry in both workspaces; verify with a fake clock
- [ ] 5.6 Pause and resume: `stop`/`resume` when the provider keeps the disk, otherwise destroy and recreate at the pull request branch; verify with the fake provider in both capability modes

## 6. End-to-end run

- [ ] 6.1 Wire admission → claim → workspace → `implement` → draft pull request → issue comment; verify with an integration test using the fake provider, a fake GitHub API and a fake agent
- [ ] 6.2 CI loop: poll every 3 minutes, `fix` on failed checks or conflict, 3 attempts, waiting does not hold a slot; verify with a fake clock covering one fix, a conflict and exhausted attempts
- [ ] 6.3 Green CI: mark ready; with auto-merge, enable GitHub auto-merge (squash if allowed) and never bypass protections; verify with fake-API tests for no review required and review required
- [ ] 6.4 Cleanup: destroy the workspace at the end, delete the branch after a confirmed merge, keep branch and pull request on failure; verify with the integration test
- [ ] 6.5 Failures: infra retries with doubled delay, hand back on agent failure or exhausted retries (labels and comment), new run when the ready label is added again; verify with integration tests

## 7. Restart and visibility

- [ ] 7.1 Reconcile on start against GitHub and workspaces (waiting CI resumes, merged while down, lost workspace); verify with tests that seed the store and the fakes
- [ ] 7.2 `RunReporter` with the event-file adapter in `IngestEvent` shape; verify that a fake agent message and tool call produce lines with the run id
- [ ] 7.3 `status` lists active runs and the last day's, with wait and failure reasons; verify with a store-seeded test

## 8. Documentation and verification

- [ ] 8.1 Guide `docs/guides/issue-factory.md`: create and install the Factory App on selected repositories, write `factory.yaml`, give secrets, run and read `status`; note worktree mode is for trusted repositories and the model key should be dedicated with a spending limit
- [ ] 8.2 Update `CLAUDE.md` and the OpenWiki pages that mention `packages/agent`
- [ ] 8.3 Run `bun run lint`, `bun run typecheck`, the tests of `packages/agent`, `packages/sandbox`, `packages/core` and the server's sandbox and GitHub App tests, and `fallow audit`
