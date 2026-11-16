# The factory is three levels — triggers, flows and threads — turned on per project

The issue factory, when it lives inside funny (ADR 0001 keeps the standalone orchestrator
for now), is not one engine. It is three levels, each with a single responsibility:

- **Trigger** — _when_ a flow starts and _with what data_. Manual, cron, the ingest
  webhook, a child agent (`funny_spawn_thread`), a git commit, and a new one: a GitHub
  issue carrying a label. A trigger never knows about steps or retries.
- **Flow** — _what steps, in what order_. A deterministic YAML (the `@funny/workflows`
  syntax) read from the repository's **default branch, never the PR branch**, so an agent
  cannot add itself a `merge` step in its own PR. A flow has two kinds of step: a **thread
  step** ("run a thread with profile X" — the only non-deterministic part, the agent's
  output) and an **action step** (commit, push, open PR, wait for CI, merge, ask for an
  approval — fixed code). Opening a PR is an action, not a thread; a review is a thread.
- **Thread** — _how_ an agent step runs. What funny already has, plus a reusable thread
  profile (prompt, model, permissions, tools, where it runs).

A single flow executor runs the steps, waits for them to finish and applies retries. It is
what `packages/orchestrator` does today; over time funny's runtime pipelines and
automations would run there too, instead of three separate orchestrators.

The factory itself is not an engine: it is a **per-project toggle**, a default flow, the
project's settings and a screen. Turning it on makes a project watch its GitHub issues
for a label and run a flow to PR or merge, as the flow dictates.

## Considered Options

- **A global factory over many repositories.** One place to watch everything, but it
  breaks funny's per-project, per-owner model and the runner isolation boundary.
- **A separate "how far it goes" setting** (draft PR · ready PR · merge) next to the
  flow. Rejected: the flow's last step already decides how far it goes, so the setting
  would be a second source of truth for the same thing.
- **A per-project runtime** (one `projects.default_mode` for all members). Rejected: the
  sandbox connection is already per `(project, user)`, so a per-project mode leaves a
  control that is half shared, half personal.

## Consequences

- **Runtime is per `(user, project)`:** `local` · `worktree` · `sandbox` (with a provider
  connection and size). It consolidates the mode and the sandbox settings into one row
  keyed by `(project_id, user_id)`; `projects.default_mode` stops being the source of the
  runtime. With no row the runtime is **`local`** — a member configures worktree or
  sandbox (Instabox or Boat, the existing `@funny/sandbox` providers) only if they want
  it. Two members of one project can run the same project in different runtimes without
  affecting each other.
- **The factory runs as whoever turned it on**, on that person's runtime: their sandbox
  connection when they chose sandbox, their runner when local or worktree. If their runner
  is offline the factory waits and shows "runner disconnected"; it never falls back to
  another runner or to sandbox on its own.
- **It turns itself off** if the person who enabled it loses access to the project or
  deletes their account; another member must turn it on in their own name.
- **The three levels compose the rest for free:** a manual thread is a one-step flow with
  a manual trigger (what funny does today, without the executor); the factory is the
  `issue-to-merge` flow with the issue trigger; code review on commit is the `code-review`
  flow with the commit trigger.
