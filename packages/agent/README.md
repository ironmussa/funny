# @funny/orchestrator

The orchestrator of the **issue factory**: a standalone process, one per user, that turns
GitHub issues marked ready for an agent into pull requests. Vocabulary is in the root
`GLOSSARY.md`; the decision to run it apart from the funny server is
`docs/adr/0001-standalone-issue-factory.md`. The work is tracked in #275.

**Status:** being rebuilt. The old factory attempt (HTTP server, Chat Completions planner,
session store, webhook workflows) has been removed. What remains are the building blocks
the new factory reuses, and stub entry points.

## Layout

`adapters/` and `bin/` as in the thread scheduler package (`packages/scheduler`), with
the pure logic and the interfaces it needs in their own `domain/` and `ports/` folders:

```
src/
  domain/          pure logic, no I/O
    state-machine.ts   generic typed state machine
    events.ts          events published on the event bus
  ports/           interfaces the factory's domain will depend on
    tracker.ts         issue source
  adapters/        implementations of the ports
    github-tracker.ts  issues through the `gh` CLI
    event-bus.ts       in-memory pub/sub with a JSONL file per run
  config/          YAML config loading (`.pipeline/config.yaml`) and its zod schema
  infrastructure/  logger, async mutex
  agents/reviewer/ PR reviewer (exported as `@funny/orchestrator/review`)
  bin/
    orchestrator.ts  long-running process: `start`, `status` (stub)
    step.ts          step runner, runs inside a factory run's workspace (stub)
```

## Commands

```bash
bun run test     # unit tests
bun run start    # funny-orchestrator start (not implemented yet)
bun run status   # funny-orchestrator status (not implemented yet)
```
