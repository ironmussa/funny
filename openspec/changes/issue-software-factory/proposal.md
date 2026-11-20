# Proposal

## Why

funny can run an agent on an issue only when a person creates the thread, writes the
prompt and later opens, watches and merges the pull request. A user who keeps a
backlog of well-specified issues has no way to let agents work through it on their
own. The existing orchestrator (`packages/agent`, `@funny/orchestrator`) was an attempt
at this, but it runs its own planner over Chat Completions, keeps credentials in the
process environment, and is wired to nothing.

## What Changes

- Rebuild `packages/agent` (`@funny/orchestrator`) into the **issue factory**: a
  standalone process, one per user, started on its own and not connected to the funny
  server (ADR 0001). It is built so a later change can report its runs into funny
  projects and threads through an adapter.
- The factory is configured from a file (`factory.yaml`): the user's GitHub login,
  commit author, model, watched projects (local path, repository, workspace kind),
  ready label, concurrency, daily limit, auto-merge and retry delay. The base branch
  and check command come from each project. Secrets (model credential, Factory App id
  and private key, sandbox provider credential) are given at startup and kept only in
  memory.
- For each watched repository, the factory admits open issues that carry the ready
  label, were opened by the configured user, are assigned to them or to nobody, and
  are not blocked. It claims the issue, works on it in a **sandbox** (default) or a
  **worktree**, runs the checks, and opens a draft pull request with `Closes #N`.
- After the pull request is open, the factory polls its CI every 3 minutes. On failure
  (or a merge conflict) it asks the same agent to fix it, up to 3 times. When CI is
  green it marks the pull request ready for review and, if auto-merge is on, merges it
  through GitHub's auto-merge, never bypassing branch protections. After a confirmed
  merge it cleans up the workspace and the branch.
- All GitHub access goes through the user's own **Factory App**, with installation
  tokens limited to one repository and renewed before they expire. No personal access
  token is used. Every git and GitHub step of a run happens inside its workspace.
- Sandboxes come from funny's existing runner templates (Boat, Instabox). The sandbox
  provider layer, the install script and the template manager move from the server
  into a new shared package, `@funny/sandbox`, used by both the server and the factory.
  The GitHub App token issuer moves into `@funny/core` for the same reason.
- State lives in a local SQLite file and is reconciled against GitHub on restart.
  Progress is visible in GitHub, in a `status` command and in a per-run event file
  whose events have the shape of funny's ingest events.
- **BREAKING** (internal only; nothing imports the package): `packages/agent` drops its
  HTTP server, routes, Chat Completions developer agent, session store, ingest
  adapter and the CI-retry / review / merge workflows built on them.

## Capabilities

### New Capabilities

- `issue-factory`: turns ready issues into draft pull requests, follows their CI, and
  optionally merges them, as a standalone process acting through a GitHub App.

### Modified Capabilities

None. The fixes to funny's workflow actions are a separate change
(`fix-workflow-thread-actions`).

## Impact

- **`packages/agent`** (`@funny/orchestrator`): rebuilt as the factory: pure logic
  behind ports, a `bin/orchestrator.ts` entry point and a `bin/sandbox-run.ts` entry
  point that runs inside a workspace.
- **New `packages/sandbox`** (`@funny/sandbox`): provider contract, registry, Boat and
  Instabox providers, runner install script and template manager, moved from
  `packages/server/src/services/thread-sandboxes/`. The server imports them from there
  with no change in behavior.
- **`packages/core`**: gains `github-app/` (App JWT and installation token issuer,
  moved from the server) and a helper that writes a token where `gh` and git read it,
  extracted from `runtime/services/sandbox-github-auth.ts`.
- **`packages/workflows`**: a `factory-issue.yaml` default workflow.
- **Docs**: a guide for creating the Factory App, writing `factory.yaml` and running the
  factory; ADR 0001.
- **Security**: the agent has shell access in its workspace and can read the App token
  and the model credential placed there. The token is limited to the watched
  repositories and one hour, only the configured user's text reaches the prompt, and
  branch protections still govern merges. Worktree mode runs the agent on the user's
  machine and is documented as for trusted repositories only.
