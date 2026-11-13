# @funny/orchestrator

The orchestrator of the **issue factory**: a standalone process, one per user, that turns
GitHub issues marked ready for an agent into pull requests. Vocabulary is in the root
`GLOSSARY.md`; the decision to run it apart from the funny server is
`docs/adr/0001-standalone-issue-factory.md`. The work is tracked in #275.

**Status:** being rebuilt. The old factory attempt (HTTP server, Chat Completions planner,
session store, webhook workflows) has been removed. The step runner's `implement` step
works; the long-running orchestrator is still a stub.

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
  adapters/        implementations of the ports
    github-tracker.ts  issues through the `gh` CLI
    event-bus.ts       in-memory pub/sub with a JSONL file per run
    gh-pull-request-opener.ts  `gh pr create --draft`
    jsonl-run-reporter.ts      appends a run's events to its event file
    workspace-action-provider.ts  workflow actions inside a workspace (agent, commands, git, PR)
  steps/
    implement.ts     the `implement` step: runs the `factory-issue` workflow
  config/          YAML config loading (`.pipeline/config.yaml`) and its zod schema
  infrastructure/  logger, async mutex
  agents/reviewer/ PR reviewer (exported as `@funny/orchestrator/review`)
  bin/
    orchestrator.ts  long-running process: `start`, `status` (stub)
    step.ts          step runner, runs inside a factory run's workspace:
                     `funny-orchestrator-step implement --spec <spec.json>`
```

## Commands

```bash
bun run test     # unit tests
bun run start    # funny-orchestrator start (not implemented yet)
bun run status   # funny-orchestrator status (not implemented yet)
```
