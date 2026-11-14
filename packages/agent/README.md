# @funny/orchestrator

The orchestrator of the **issue factory**: a standalone process, one per user, that turns
GitHub issues marked ready for an agent into pull requests. Vocabulary is in the root
`GLOSSARY.md`; the decision to run it apart from the funny server is
`docs/adr/0001-standalone-issue-factory.md`. The work is tracked in #275.

**Status:** being rebuilt. The old factory attempt (HTTP server, Chat Completions planner,
session store, webhook workflows) has been removed. `start` runs worktree factory runs end
to end: every minute it admits ready issues, takes each to a draft pull request, follows
its CI, has the same agent fix failing checks and conflicts, and marks it ready for review
once green. Infrastructure failures are retried
and failed issues are handed back; with `auto_merge` on, green pull requests are merged
through GitHub's auto-merge; factory runs survive a restart. Sandbox workspaces are not
built yet (#275); a sandbox project is skipped with a warning.

## Running it

The factory is started on its own, never by `bun run dev`:

```bash
bun run factory:start                      # settings from ~/.funny/factory/config.yaml
bun run factory:start -- --config ./factory.yaml
bun run factory:status                     # the runs in the state store
```

The factory home is `FUNNY_FACTORY_HOME` (default `~/.funny/factory`): the default
settings file `config.yaml` and the state store `state.db` (SQLite: runs and a per-day
counter of started runs).

### A factory run

On each tick (every 60 seconds) the orchestrator lists the open issues with the ready
label in each worktree project, oldest first, and admits those opened by the configured
login that have no active factory run, within the concurrency and daily limits. A factory run then:

1. **claims** the issue through the Factory App: assigns the login, swaps the ready label
   for the in-progress one, and comments;
2. **works** in `<factory home>/runs/<run id>/`: a git worktree of the project on
   `factory/issue-<n>-<id>` from the base branch (the project's `base`, else the
   repository's default branch), and runs the step runner's `implement` step as a child
   process;
3. opens the draft pull request (**`pr_open`**) and **waits for CI** (`waiting_ci`). Every
   3 minutes (no webhook) it reads the head commit's check runs and statuses and the pull
   request's mergeability:
   - green: the pull request is marked ready for review (**`ready`**). With `auto_merge:
true` the factory also enables GitHub's auto-merge (**`merging`**), with squash when the
     repository allows it, else another allowed method; GitHub merges once the branch
     protections are met (required reviews and checks still apply, nothing is bypassed).
     When a pull request already meets them, GitHub refuses auto-merge ("clean status") and
     the factory merges it at once the same way. Once merged the factory run is
     **`merged`**, and its worktree, local branch, credentials and remote branch are
     removed (its `events.jsonl` stays). A pull request that turns red while it waits to
     merge goes back to waiting for CI; one closed without merging fails the factory run.
     Auto-merge turned off while the pull request stays green is enabled again; a direct
     merge is of the commit whose CI was green, and one GitHub refuses waits. A cleanup
     that fails is tried again before the factory run is `merged`.
     A repository without auto-merge leaves the pull request ready. A `ready` pull request
     that a person merges later is noticed (every 30 minutes) and cleaned up the same way;
   - a failing check, or a conflict with the base: the step runner's `fix` step (**`fixing`**)
     resumes the same agent session with the failing checks and the end of their logs, or
     asks it to rebase onto the base, runs the checks, and pushes; then it waits again;
   - no check reported yet: it keeps waiting; with none 15 minutes after the last push the
     repository is taken to have no CI, and the pull request is marked ready with that reason;
   - a fix the agent could not finish (it changed nothing, the rebase is unfinished, the
     local checks stay red) uses up an attempt and the factory run keeps waiting for CI;
   - after 3 fix attempts (conflicts included) without green CI, the factory run is
     **`failed`**.

**Failures** are of two kinds. An **infrastructure** failure (GitHub, the network, git, the
token, the workspace) is retried: before the pull request the factory run goes back to
`queued` and starts over on a fresh branch after `retry_delay_minutes`, then after twice
that; in a fix it waits for CI again after that delay (without using up a fix attempt).
Reading CI and marking the pull request ready are retried the same way. The two retries are
per factory run, across all its steps. After two retries it fails. Errors of the agent CLI
that come from the model provider (rate limits, overload, a refused key, the network) count
as infrastructure failures. An **agent** failure (checks that never pass, no changes, the
agent erroring) is not retried. A failed factory run hands its issue back: a comment says
why, the in-progress and ready labels are removed (the login stays assigned), and its
branch and pull request are kept. Adding the ready label again starts a new factory run. Until the hand-back has gone
through (it is retried on every tick), the issue is not admitted again. Runs in `queued`,
`claiming`, `working` and `fixing` hold a concurrency slot; waiting for CI or to merge does
not. The
states show in `status` and, with the steps' own events, in the run's `events.jsonl`.

**A factory run never uses your GitHub access.** It has a home of its own (`runs/<id>/home`), a
`gh` config directory with its own Factory App token for the repository (`runs/<id>/gh`,
renewed 5 minutes before it expires, also during a long step) and a git config whose
credential helper asks that `gh` (`runs/<id>/gitconfig`). Git and the step runner run with
exactly that environment (plus `PATH`, locale, `TMPDIR`, the configured commit identity and
the model key as `ANTHROPIC_API_KEY`), so your `gh` login, `~/.gitconfig` and `GH_TOKEN`
are neither read nor changed. Credential helpers in the project's own `.git/config` (a
keychain) are overridden too, so only the run's `gh` answers for github.com. The worktree
still shares the project's `.git` directory (its other settings, its hooks), which is why
worktree mode is for trusted repositories only. On `Ctrl-C`, `start` stops admitting and
waits for the factory runs in flight.

### Restarts

Factory runs survive a restart of the orchestrator, even an abrupt one. Before its first
tick, `start` reconciles the state store with GitHub and the workspaces:

- a step child the previous process left running (its pid is in `runs/<id>/step.pid`) is
  stopped first, so it cannot push or open a pull request next to the retry;
- a factory run interrupted before its pull request adopts the open pull request from its
  branch if GitHub has one (a stop right after opening it), with the agent session its
  step recorded (a later fix without one starts a new session); otherwise its pushed
  branch is deleted and it retries as an infrastructure failure. When GitHub cannot be
  asked it is asked again on the next tick: it never opens a second pull request or starts
  a second factory run for the issue;
- one interrupted in a fix waits for CI again, as an infrastructure failure;
- one waiting on its pull request records a merge or a close that happened meanwhile
  (`merged` with cleanup, or `failed`), treats a vanished workspace as an infrastructure
  failure (the next fix recreates it from the pushed branch), and otherwise looks at the
  pull request on the first tick.

A factory run in a working state that nothing in the running process works on is
reconciled the same way on any tick, and runs of projects no longer in the settings hold
no concurrency slot.

### Factory settings

```yaml
github:
  login: octo-owner # only this user's issues are admitted
  author: { name: Octo Owner, email: octo@example.com } # commit author
model: sonnet
labels: { ready: ready-for-agent, in_progress: agent-in-progress } # defaults
limits: { concurrency: 2, daily: 10 } # defaults
auto_merge: false # default
retry_delay_minutes: 30 # default
sandbox: { provider: boat, size: small } # required when a project uses a sandbox
projects:
  - path: ~/code/app # local checkout (relative to this file if not absolute)
    repo: acme/app
    workspace: sandbox # default; or `worktree` (trusted repositories only)
    base: main # default: the repository's default branch
    check: bun run lint # optional
```

`start` refuses an invalid file and names the field (`projects.0.repo: expected
owner/name`, `colour: unknown field`), and refuses a file with a key or value that looks
like a secret.

### Secrets

Given at startup only, from the environment or, on a terminal, a prompt (no echo). They
live in memory and are replaced by `[redacted]` in every log line.

| Variable                           | What                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `FUNNY_FACTORY_MODEL_KEY`          | model credential: use a dedicated key with a spending limit     |
| `FUNNY_FACTORY_APP_ID`             | the Factory App's numeric id                                    |
| `FUNNY_FACTORY_APP_PRIVATE_KEY`    | its private key (PEM; `\n` escapes allowed)                     |
| `FUNNY_FACTORY_SANDBOX_CREDENTIAL` | the sandbox provider's credential (only with a sandbox project) |

## The `fix` step

Run in the run's checkout when its pull request needs a fix, it resumes the run's agent
session (`sessionId`) so the agent keeps the context of its implementation. For failing
checks it gives the agent their names, conclusions and log excerpts; for a conflict it
fetches the base and asks the agent to `git rebase origin/<base>` and resolve it, then
verifies the rebase finished. The check command runs with up to two in-place fixes, any
leftover change is committed with the configured author, and the branch is pushed
(`--force-with-lease` after a rebase). It writes `pushed` or `failed` to the exit marker.

## The `implement` step

Run in the workspace's checkout, already on the run's branch, it runs the built-in
`factory-issue` workflow (`packages/workflows/defaults/factory-issue.yaml`): the agent
implements the issue, the check command runs with in-place fixes in the same agent
session, and the result is committed with the configured author, pushed, and opened as a
draft pull request against the base that closes the issue. It prints `pr_url=…` and
`session_id=…`, appends its events to `eventsPath`, and writes the outcome to
`exitMarkerPath` last. Checks that never pass or a run that changed nothing open no pull
request and end as an agent failure; git or GitHub errors end as an infrastructure
failure.

A repository can replace the workflow by committing its own at
`.funny/workflows/factory-issue.yaml` (or `.yml`; `.yaml` wins) on the base branch, for
example to use its own skills. It is read from the base branch, never from the run's
branch or working tree, so the agent cannot change what a later step runs. It must be named `factory-issue`; it receives the same inputs
(`issue_number`, `issue_title`, `issue_body`, `base`, `branch`, `check_command`,
`pr_body`), and its pull request is always opened as a draft. An override that is
present but invalid fails the step as an agent failure naming the file; the default is
never used in its place.

## Layout

`adapters/` and `bin/` as in the thread scheduler package (`packages/scheduler`), with
the pure logic and the interfaces it needs in their own `domain/` and `ports/` folders:

```
src/
  domain/          pure logic, no I/O
    state-machine.ts   generic typed state machine
    events.ts          events published on the event bus
    pull-request-body.ts  body of a run's pull request (`Closes #N`, checks note)
    step-outcome.ts    how a step ended (PR opened, agent or infra failure)
    factory-run.ts     the run state machine
    retry-policy.ts    when an infrastructure failure is retried
  ports/           interfaces the factory depends on
    tracker.ts         issue source
    pull-requests.ts   opening a draft pull request from a workspace
    run-reporter.ts    a run's events, in funny's ingest event shape
    run-store.ts       the factory's runs and per-day counter
    pull-request-ci.ts a run's pull request after it opened: CI state, mark ready
    issue-source.ts    ready issues, trusted text, claiming (through the Factory App)
    workspaces.ts      where a run works, and how the step runner is started
    clock.ts           time, faked in tests
  adapters/        implementations of the ports
    github-tracker.ts  issues through the `gh` CLI
    event-bus.ts       in-memory pub/sub with a JSONL file per run
    gh-pull-request-opener.ts  `gh pr create --draft`
    jsonl-run-reporter.ts      appends a run's events to its event file
    sqlite-run-store.ts        the run store in `state.db` (`bun:sqlite`)
    factory-app.ts             the Factory App's repository tokens
    factory-github.ts          REST / GraphQL calls with the repository's App token
    github-app-issue-source.ts the issue source over GitHub's REST API
    github-app-pull-requests.ts check runs, statuses, mergeability, job logs, ready for review
    worktree-workspace.ts      worktree workspaces and the step runner as a child process
    workspace-action-provider.ts  workflow actions inside a workspace (agent, commands, git, PR)
  steps/
    implement.ts     the `implement` step: runs the `factory-issue` workflow
    factory-workflow.ts  picks the repository's override or the built-in workflow
    fix.ts           the `fix` step: resumes the session to fix CI or rebase
    fix-prompts.ts   its prompts
    step-io.ts       spec fields, event file and exit marker shared by the steps
  settings/        factory settings (schema, loading, refusals) and secrets
  factory.ts       the factory: admission and the tick's loops over its runs
  factory/         its parts: context, failures (retries, hand-back), implement-run,
                   pull-request (CI follow-up, fixes), merge (auto-merge, cleanup),
                   reconcile (state against GitHub and the workspaces on start)
  run-recorder.ts  state changes through the state machine, saved and reported
  compose.ts       wires the factory from its real parts and the given edges
  cli.ts           the `start` and `status` commands, with their edges injected
  config/          the old YAML config loading (`.pipeline/config.yaml`)
  infrastructure/  redacting factory log (the orchestrator logs only through it), TTY secret
                   prompt, async mutex, pino logger (old modules)
  agents/reviewer/ PR reviewer (exported as `@funny/orchestrator/review`)
  bin/
    orchestrator.ts  long-running process: `start`, `status`
    step.ts          step runner, runs inside a factory run's workspace:
                     `funny-orchestrator-step <implement|fix> --spec <spec.json>`
```

## Commands

```bash
bun run test     # unit tests
bun run start    # funny-orchestrator start (not implemented yet)
bun run status   # funny-orchestrator status (not implemented yet)
```
