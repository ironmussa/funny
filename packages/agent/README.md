# @funny/orchestrator

The orchestrator of the **issue factory**: a standalone process, one per user, that turns
GitHub issues marked ready for an agent into pull requests. Vocabulary is in the root
`GLOSSARY.md`; the decision to run it apart from the funny server is
`docs/adr/0001-standalone-issue-factory.md`. The work is tracked in #275.

**Status:** being rebuilt. The old factory attempt (HTTP server, Chat Completions planner,
session store, webhook workflows) has been removed. `start` runs worktree factory runs end
to end: every minute it admits ready issues, claims them and runs the `implement` step to a
draft pull request. Sandbox workspaces, CI follow-up, retries and restart reconciliation
are not built yet (#275); a sandbox project is skipped with a warning.

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
3. ends in **`pr_open`** with the draft pull request, or **`failed`** with the reason.

`queued → claiming → working → pr_open` (or `failed`) shows in `status` and, with the
step's own events, in the run's `events.jsonl`.

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
  ports/           interfaces the factory depends on
    tracker.ts         issue source
    pull-requests.ts   opening a draft pull request from a workspace
    run-reporter.ts    a run's events, in funny's ingest event shape
    run-store.ts       the factory's runs and per-day counter
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
    github-app-issue-source.ts the issue source over GitHub's REST API
    worktree-workspace.ts      worktree workspaces and the step runner as a child process
    workspace-action-provider.ts  workflow actions inside a workspace (agent, commands, git, PR)
  steps/
    implement.ts     the `implement` step: runs the `factory-issue` workflow
    factory-workflow.ts  picks the repository's override or the built-in workflow
  settings/        factory settings (schema, loading, refusals) and secrets
  factory.ts       the factory: admission on each tick and the run lifecycle
  compose.ts       wires the factory from its real parts and the given edges
  cli.ts           the `start` and `status` commands, with their edges injected
  config/          the old YAML config loading (`.pipeline/config.yaml`)
  infrastructure/  redacting factory log (the orchestrator logs only through it), TTY secret
                   prompt, async mutex, pino logger (old modules)
  agents/reviewer/ PR reviewer (exported as `@funny/orchestrator/review`)
  bin/
    orchestrator.ts  long-running process: `start`, `status`
    step.ts          step runner, runs inside a factory run's workspace:
                     `funny-orchestrator-step implement --spec <spec.json>`
```

## Commands

```bash
bun run test     # unit tests
bun run start    # funny-orchestrator start (not implemented yet)
bun run status   # funny-orchestrator status (not implemented yet)
```
