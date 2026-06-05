# funny — Documentation index

This directory holds **durable** documentation: guides, architecture, design notes, reports, active RFCs, and tracked implementation plans. The local [`openspec/`](../openspec/) tree is **gitignored**; use [`plans/`](./plans/) for version-controlled plans.

## Root docs (repo entry points)

| Doc                         | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| [README.md](../README.md)   | Product overview, features, quick start               |
| [INSTALL.md](../INSTALL.md) | Installation, deployment, team mode, trust boundaries |
| [CLAUDE.md](../CLAUDE.md)   | Conventions for AI agents working in this repo        |

## Guides

How to use or operate funny.

| Doc                                               | Purpose                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| [ingest-api.md](./guides/ingest-api.md)           | External agent webhook API                              |
| [process-cleanup.md](./guides/process-cleanup.md) | Ghost sockets, port cleanup, Windows handle inheritance |

## Architecture

System design that should stay accurate as the product evolves.

| Doc                                                                           | Purpose                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [pipeline.md](./architecture/pipeline.md)                                     | Post-commit review/corrector pipeline and worktree isolation                                                  |
| [process-execution-strategy.md](./architecture/process-execution-strategy.md) | Historical proposal for process execution (see `packages/core/src/git/process.ts` for current implementation) |

## Design

Feature-specific notes and deferred work.

| Doc                                                                 | Purpose                                 |
| ------------------------------------------------------------------- | --------------------------------------- |
| [browser-panel-screenshot.md](./design/browser-panel-screenshot.md) | Screenshot options when CDP mode is off |

## Reports

Point-in-time audits and living gap trackers (may go stale; check dates).

| Doc                                                                                      | Purpose                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [2026-04-23-architecture-evaluation.md](./reports/2026-04-23-architecture-evaluation.md) | ATAM-style architecture health report          |
| [security-regression-gaps.md](./reports/security-regression-gaps.md)                     | Security findings without tractable unit tests |

## RFCs

Active design documents referenced from code during migrations.

| Doc                                                      | Purpose                                            |
| -------------------------------------------------------- | -------------------------------------------------- |
| [route-driven-threads.md](./rfc/route-driven-threads.md) | URL as source of truth for active thread selection |

## Plans (implementation)

In-flight proposals tracked in git. Remove entries when shipped.

| Doc                                                | Purpose                                       |
| -------------------------------------------------- | --------------------------------------------- |
| [plans/README.md](./plans/README.md)               | Index of active plans                         |
| [plans/observability.md](./plans/observability.md) | `@funny/observability` + local Victoria stack |

## Package-local docs

| Location                                                          | Contents                                    |
| ----------------------------------------------------------------- | ------------------------------------------- |
| [`packages/evflow/docs/`](../packages/evflow/docs/)               | evflow DSL API, sequences, plugin, examples |
| [`packages/design-client/docs/`](../packages/design-client/docs/) | Design client spec and ADRs                 |
| [`e2e/TEST-PLAN.md`](../e2e/TEST-PLAN.md)                         | E2E test plan                               |
