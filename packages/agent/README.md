# @funny/orchestrator

The orchestrator of the **issue factory**: a standalone process, one per user, that turns
GitHub issues marked ready for an agent into pull requests. Vocabulary is in the root
`GLOSSARY.md`; the decision to run it apart from the funny server is
`docs/adr/0001-standalone-issue-factory.md`. The work is tracked in #275.

**Status:** being rebuilt. The old factory attempt (HTTP server, Chat Completions planner,
session store, webhook workflows) has been removed. The step runner's `implement` step
works; the orchestrator reads its settings and secrets and `start` / `status` run, but it
does not admit issues yet.

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
  ports/           interfaces the factory's domain will depend on
    tracker.ts         issue source
    pull-requests.ts   opening a draft pull request from a workspace
    run-reporter.ts    a run's events, in funny's ingest event shape
    run-store.ts       the factory's runs and per-day counter
  adapters/        implementations of the ports
    github-tracker.ts  issues through the `gh` CLI
    event-bus.ts       in-memory pub/sub with a JSONL file per run
    gh-pull-request-opener.ts  `gh pr create --draft`
    jsonl-run-reporter.ts      appends a run's events to its event file
    sqlite-run-store.ts        the run store in `state.db` (`bun:sqlite`)
    workspace-action-provider.ts  workflow actions inside a workspace (agent, commands, git, PR)
  steps/
    implement.ts     the `implement` step: runs the `factory-issue` workflow
    factory-workflow.ts  picks the repository's override or the built-in workflow
  settings/        factory settings (schema, loading, refusals) and secrets
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
