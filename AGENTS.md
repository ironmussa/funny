# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Railway — Funny remote

When asked to connect to Railway for this repository, use the Railway CLI (or
GraphQL API) with the project token in `.env.railway-token.local` at the repository
root. This ignored local file exports `RAILWAY_TOKEN`; never copy its value into
documentation, tracked files, command output, or messages.

- Default project: `feisty-solace` (`373f9d06-a436-4292-b20c-9f0b2096a588`).
- Default environment: `production` (`f9b2196c-7ce6-4045-976e-fdf8763b911f`).
- Load the token only in a subshell for the Railway operation, clearing any
  inherited `RAILWAY_API_TOKEN`. Do not use the account-wide MCP or global login
  as a fallback. If the file is missing (for example, in a new checkout/worktree),
  request local credential setup instead.
- Verify the token's project/environment with the read-only GraphQL query
  `query { projectToken { projectId environmentId } }` before mutations. Send
  the token via the `Project-Access-Token` header for GraphQL. Stop on a scope
  mismatch; use explicit service/environment IDs where supported.
- A request to connect authorizes authentication and reads, not deployments or
  other mutations unless the user also requests them.

From the repository root, load credentials for a CLI command like this:

```bash
(
  unset RAILWAY_API_TOKEN RAILWAY_TOKEN
  . ./.env.railway-token.local
  railway status --json
)
```

The local credentials file must have owner-only permissions (`chmod 600`) and
contain `export RAILWAY_TOKEN='...'`. Keep it out of application runtime env files
and Git; `.gitignore` already excludes `.env.*` except `.env.example`.

## Effect for asynchronous workflows

- Prefer Effect where it helps coordinate asynchronous workflows: cancellation,
  retries/backoff, timeouts, bounded concurrency, and resource lifetimes.
- Keep simple pure functions and UI rendering idiomatic; do not wrap every function
  or Promise just to use Effect.
- Preserve existing `neverthrow` domain results. Effect complements them for async
  orchestration; adopting Effect does not require replacing `Result` / `ResultAsync`.
- Keep Effect execution at explicit Promise/API boundaries. Connect interruption to
  the underlying AbortSignal or provider cancellation, and register cleanup for owned
  resources. Wrapping a Promise alone cannot stop external side effects.
- Retry only operations whose retry policy is explicit and safe. Test cancellation
  during execution and backoff, exhausted retries, and concurrency limits.

## Verification

- Always run `bun run lint` and `bun run typecheck` before considering code changes complete.
- Format with oxfmt (`bun run format`, or `bunx oxfmt --write <files>`), never prettier: there is no prettier config, so it silently rewrites files to its own defaults. The pre-commit hook re-formats staged files with oxfmt.
- Add or update a test when a change affects behavior, fixes a bug, or introduces enough risk that automated coverage is warranted.

## OpenWiki

Structured documentation for this repository lives in [openwiki/quickstart.md](openwiki/quickstart.md):
repository overview, architecture, agent-execution flow, pipelines/automation, thread & worktree
domain rules, integrations/standalone services, operations/auth, and the development workflow.
Consult it when searching for context about how this codebase works.
