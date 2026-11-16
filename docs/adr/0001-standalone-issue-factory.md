# The issue factory is a standalone process per user, acting through a GitHub App

The issue factory (see `GLOSSARY.md`) runs as its own process, the orchestrator, one per
user, and does not talk to the funny server yet. It is configured from a file, runs its
agents in a sandbox by default (or a worktree), and reaches GitHub only through its own
GitHub App, installed on the repositories it watches. No personal access token is used.
It reuses funny's libraries (`@funny/core`, `@funny/pipelines`, `@funny/workflows`, and a
`@funny/sandbox` package shared with the server) rather than funny's server, runners or
database, and is built to report into funny projects and threads later through an
adapter.

## Considered Options

- **A feature of the funny server** (policy per project, runs on project members'
  runners, admission by GitHub assignee). Keeps runner isolation and the funny UI, but
  ties the factory to a running funny server and to funny's users and runners before
  the factory itself is proven.
- **A separate process driven by funny's system API.** Still needs the server for every
  step, so it is not independent in practice.
- **A personal access token instead of an App.** Simpler to set up, but the agent can
  read whatever credential its sandbox holds, and a PAT reaches every repository the
  user can. App installation tokens are limited to one repository and expire in an
  hour.

## Consequences

- Every git and GitHub step happens inside the sandbox, so the agent can read the App
  token. Its scope (the watched repositories, one hour) and the repository's branch
  protections are what limit a prompt injection; the factory never bypasses them.
- The agent can also read the model credential given to the sandbox; use a dedicated
  key with a spending limit until the factory goes through funny's LLM proxy.
- Pull requests, comments and merges appear as the App's bot; commits use the
  configured author.
- Without funny there is no shared UI; progress is visible in GitHub, in a `status`
  command and in a per-run event file whose events have the shape funny's ingest
  already understands.
