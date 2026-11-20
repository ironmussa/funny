# Design

## Context

See proposal.md for motivation and ADR 0001 for why the factory is standalone.

What exists and is reused:

- **`packages/agent`** (`@funny/orchestrator`): a `Tracker` port with a GitHub
  implementation (`trackers/`), a generic state machine (`core/state-machine.ts`),
  config loading (`config/`), an event bus and a mutex. Nothing imports the package.
  Its developer agent (`agents/developer/`, Chat Completions), session store, Hono
  server, routes and ingest adapter are replaced. The reviewer (`./review` export) is
  out of scope and left as is.
- **`@funny/pipelines`** runs a workflow graph against an `ActionProvider`;
  **`@funny/workflows`** parses YAML workflows and ships defaults.
- **`@funny/core/agents`** spawns Claude Code agents with session resume.
- **Sandboxes** (`packages/server/src/services/thread-sandboxes/`): a `SandboxProvider`
  contract (`create`, `status`, `stop`, `resume`, `exec`, `destroy`, `capabilities`), a
  registry, Boat and Instabox providers, and a runner template: an install script that
  checks out funny at a commit into `/opt/funny`, installs dependencies, and registers
  a systemd runner unit that only starts when `/etc/funny/sandbox.env` exists. The
  template manager keeps one template per provider account and commit. These depend
  only on `neverthrow`, `zod`, `@funny/shared/async` and the server's logger and
  telemetry.
- **GitHub App** (`server/services/github-app/`): JWT signing and an installation token
  issuer limited to one repository; `runtime/services/sandbox-github-auth.ts` writes a
  token where `gh` and git read it and renews it before expiry.
- **Ingest events** (`runtime/services/ingest-mapper.ts`, `IngestEvent`): the shape
  funny already turns into a thread with messages and tool calls.

## Goals / Non-Goals

**Goals:**

- One user can run the factory on their machine against their repositories with a
  config file, a Factory App and a sandbox provider account, without a funny server.
- Every GitHub action uses a short-lived, repository-limited token.
- A later change can send runs into funny threads by adding one reporter adapter and a
  public API endpoint, without changing the factory's logic.

**Non-Goals:**

- Connecting to funny (projects, threads, UI, runners, LLM proxy) in this change.
- Several users per process, or a team view.
- Responding to pull request reviews.
- Trackers other than GitHub.
- The workflow-action fixes in funny's runtime (change `fix-workflow-thread-actions`).

## Decisions

### 1. The orchestrator is ports and a loop

`packages/agent` is rebuilt with the layout of `packages/scheduler`:

- **Domain (pure):** admission (`planAdmission(issues, runs, limits, now)`), the run
  state machine, prompt and pull request body builders, retry policy.
- **Ports:** `IssueSource` (list ready issues, read one with comments, claim, comment,
  label, assign), `PullRequests` (checks, conflicts, mark ready, enable auto-merge,
  delete branch), `Workspaces` (see 4), `RunStore`, `RunReporter`, `Clock`.
- **Adapters:** GitHub through the Factory App, sandbox and worktree workspaces,
  SQLite, the event-file reporter.
- **Entry points:** `bin/orchestrator.ts` (the long-running loop plus `status`), and
  `bin/sandbox-run.ts` (the step runner that runs inside a workspace, see 5).

The loop ticks every 60 seconds for admission and every 3 minutes per run waiting for
CI, with a per-repository timeout and bounded concurrency, using Effect for the
schedules, cancellation and retries.

_Alternative: keep the existing workflows (`issue-pipeline`, `ci-retry`, `merge`) and
swap their executor._ Rejected: they are written around the in-process developer agent
and the session store; the state machine and tracker are what carry over.

### 2. Configuration file and startup secrets

`factory.yaml` (path from `--config`, default `./factory.yaml`) is validated with zod:

```yaml
github:
  login: octocat
  commitAuthor: { name: Octo Cat, email: octo@example.com }
model: claude-opus-5-5
labels: { ready: ready-for-agent, inProgress: agent-in-progress }
limits: { concurrency: 2, perDay: 5 }
autoMerge: false
retryDelayMinutes: 30
sandbox: { provider: boat, sizeId: medium }
projects:
  - path: ~/code/app
    repo: octocat/app
    workspace: sandbox # or worktree
    baseBranch: main # optional; default: the repository's default branch
    checkCommand: bun run lint && bun test # optional
```

`baseBranch` and `checkCommand` are facts of the project; when omitted, the base branch
is the repository's default branch and there are no local checks. Secrets come from
`FACTORY_CLAUDE_TOKEN` (or `ANTHROPIC_API_KEY`), `FACTORY_GITHUB_APP_ID`,
`FACTORY_GITHUB_APP_PRIVATE_KEY` (or `_FILE`) and the provider credential
(`FACTORY_SANDBOX_TOKEN`), or are prompted for on a TTY. Keys whose names look like
secrets are refused in the file.

### 3. GitHub through the Factory App

The token issuer and App JWT move from `server/services/github-app/` to
`packages/core/src/github-app/`; the server imports them from there. The server's
caps on the owner's PAT stay in the server; the factory has no PAT, so its tokens get
the App's write permission set (`contents`, `pull_requests`, `issues`, `workflows`
write; `actions`, `checks`, `statuses`, `metadata` read), limited to one repository.
The App installation on selected repositories is the boundary.

The orchestrator uses tokens on the host for polling, claiming, commenting, labels,
checks and merges. A run receives its own token in its workspace for git and `gh`,
written by a helper extracted from `sandbox-github-auth.ts` (`gh` `hosts.yml` plus
`gh auth git-credential` as git's helper) and rewritten by the orchestrator 5 minutes
before expiry. In worktree mode the helper writes to a per-run `GH_CONFIG_DIR` and the
run's git config, never the user's.

### 4. Workspaces: sandbox by default, worktree on request

`Workspaces` has two adapters with the same interface: `create(run)`, `exec(step)`,
`pause()`, `resume()`, `destroy()`.

- **Sandbox:** the provider layer, install script and template manager move to the new
  package `packages/sandbox` (`@funny/sandbox`), with logging and metrics as injected
  ports; the server imports them from there unchanged. The factory builds or reuses a
  template of its own commit (so `/opt/funny` contains `bin/sandbox-run.ts`), creates
  the sandbox, and never writes `/etc/funny/sandbox.env`, so funny's runner unit never
  starts. `CreateSandboxRequest.threadId` is generalized to an owner key that the
  factory fills with the run id. Run secrets are written through `exec` to a root-only
  file (the same pattern as `startRunnerCommand`), not through `create`'s env, which
  stays for bootstrap values only. The repository is cloned inside the sandbox with
  the run's token.
- **Worktree:** a git worktree of the project's local repository (via
  `@funny/core/git`), and `bin/sandbox-run.ts` as a child process in it with a scrubbed
  environment plus the run's token configuration.
- **Pause:** if `capabilities().stopPreservesDisk`, `stop`/`resume`; otherwise
  `destroy` and, for a fix, a new sandbox cloned at the pull request's branch.

### 5. Inside the workspace: `sandbox-run` and `factory-issue.yaml`

`bin/sandbox-run.ts` runs one step of a run with `@funny/pipelines` and a
`WorkspaceActionProvider` that is local to the workspace: agents through
`@funny/core/agents` (Claude Code, the configured model, session resume), git through
`@funny/core/git`, and `gh` for pull requests. The steps are:

- `implement`: run `factory-issue.yaml` (agent implements → checks with in-place fix
  attempts → commit → push → draft pull request), and print the pull request URL and
  the agent session id.
- `fix`: resume the session with the CI failure or the conflict, run checks, push.

Because `exec` returns only when its command ends, the orchestrator starts
`sandbox-run` detached (`nohup … &`), and reads its event file and exit marker with
short `exec` calls. The same event file feeds the reporter (7).

The default prompt is self-contained (no skills); a repository can override
`.funny/workflows/factory-issue.yaml`.

### 6. Run state and limits

```
queued → claiming → working → pr_open → waiting_ci ⇄ fixing → ready | merging → merged
                         ↘ failed (agent | infra) ↙
```

`working`, `claiming` and `fixing` hold a concurrency slot; `waiting_ci` and `merging`
do not. The daily limit counts runs started per local day. An infrastructure failure
moves the run back to `queued` with `notBefore = now + delay × 2^attempt`, at most 2
times; an agent failure, or infra after its retries, ends in `failed` and hands the
issue back. A merge conflict or a failed check in `waiting_ci` moves to `fixing` while
attempts remain (3 per run).

### 7. State, reconciliation and reporting

`RunStore` is SQLite (`bun:sqlite`) at `~/.funny-factory/factory.db`: runs (issue,
repository, branch, workspace handle, session id, pull request, state, attempts,
`notBefore`, last error) and a per-day counter. On start the orchestrator reconciles
each non-final run with GitHub (pull request merged or closed, labels) and the
workspace (`status`), as the scenarios in the spec state.

`RunReporter` receives events with the fields of `IngestEvent` (`event_type`,
`request_id`, `thread_id` = run id, `timestamp`, `data`). The v0 adapter appends JSON
lines to `~/.funny-factory/runs/<run-id>.jsonl`; `status` reads the store. A later
change adds a funny adapter that posts the same events to a new `/api/v1` endpoint for
external threads, authenticated with a personal API token like the Chrome extension.

### 8. Trusted text

The `IssueSource` adapter returns the body only for issues opened by the configured
login and drops comments from anyone else before the prompt builder sees them, so the
rule does not depend on the builder alone.

## Risks / Trade-offs

- [The agent can read the App token and the model credential in its workspace] →
  Repository-limited one-hour tokens, the trusted-text rule, branch protections, and a
  dedicated model key with a spending limit (documented).
- [Worktree mode runs an agent with shell on the user's machine] → Off by default,
  documented as for trusted repositories, scrubbed environment.
- [Moving sandbox and App code out of the server could change its behavior] → Moves
  only; the server's existing sandbox and GitHub App tests must pass unchanged.
- [Template per factory commit means a template build on first use] → The template
  manager already builds on demand and dedupes; first run waits for it.
- [Polling GitHub for many repositories] → Per-repository timeouts, one list call per
  repository per tick, and conditional requests (ETags) where the API supports them.
- [Auto-merge of agent code] → Off by default, and only through GitHub's auto-merge, so
  required reviews and checks still apply.

## Migration Plan

1. Extract `@funny/sandbox` and `@funny/core/github-app` with the server switched over
   and its tests green, before any factory code uses them.
2. Build the factory behind its own entry point; nothing in funny starts it.
3. Delete the replaced parts of `packages/agent` in the same change.

Rollback: the factory is opt-in and separate; reverting the extraction commits
restores the server's local copies.

## Open Questions

- Whether `@funny/sandbox`'s template should later include the factory entry point by
  default, so the server's template and the factory's are the same build.
- Whether the factory should accept issues marked as blocked through GitHub's native
  issue dependencies only, or also a `Blocked by #N` line in the body.
