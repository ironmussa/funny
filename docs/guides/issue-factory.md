# The issue factory

The issue factory turns GitHub issues you mark ready into pull requests, with no person in
the loop. It runs as its own process, the **orchestrator**, one per user, apart from the
funny server: it watches your repositories, picks up issues labelled `ready-for-agent`,
and takes each one through a **factory run**. A factory run claims the issue, has a Claude
Code agent implement it in a sandbox (or a git worktree), opens a draft pull request,
follows its CI and has the same agent fix what fails, and finally marks the pull request
ready for review, or merges it through GitHub's auto-merge if you allow that.

The decision to run it apart from funny is
[ADR 0001](../adr/0001-standalone-issue-factory.md); the vocabulary (issue factory,
orchestrator, factory run, factory settings, Factory App) is in
[`GLOSSARY.md`](../../GLOSSARY.md). The code is `packages/agent` (`@funny/orchestrator`).

Read [the security model](#security-model) before you start it on a repository.

## 1. Create the Factory App

The factory reaches GitHub only through its own GitHub App, the **Factory App**. There is
no personal access token anywhere: the factory mints an installation token per
repository, limited to that repository and valid for an hour.

1. On GitHub, open **Settings > Developer settings > GitHub Apps > New GitHub App** (under
   your account, or an organization you own).
2. Give it a name (e.g. `octo-owner-factory`) and any homepage URL. **Uncheck Webhook >
   Active**: the factory polls, it needs no webhook.
3. Under **Repository permissions** grant exactly these:

   | Permission      | Access         | Used for                                                                                       |
   | --------------- | -------------- | ---------------------------------------------------------------------------------------------- |
   | Contents        | Read and write | cloning, pushing the run's branch, deleting it after a merge                                   |
   | Pull requests   | Read and write | opening the draft, marking it ready, enabling auto-merge                                       |
   | Issues          | Read and write | reading ready issues and their blockers, claiming, labels, comments, hand-backs                |
   | Workflows       | Read and write | pushing changes the agent makes under `.github/workflows/` (required: every token asks for it) |
   | Actions         | Read-only      | the end of a failed job's log, given to the agent for a fix                                    |
   | Checks          | Read-only      | the pull request's check runs                                                                  |
   | Commit statuses | Read-only      | the pull request's commit statuses                                                             |
   | Metadata        | Read-only      | (mandatory)                                                                                    |

   No organization or account permissions.

4. **Where can this GitHub App be installed?** _Only on this account._
5. Create it, note its **App ID**, and under **Private keys** generate a key: a `.pem`
   file is downloaded. Keep it out of every repository.
6. **Install App** > your account > **Only select repositories** > choose the repositories
   the factory should work on, and nothing else. The installation is the factory's
   boundary: it can never touch a repository the App is not installed on.

A watched repository where the App is not installed is reported by the orchestrator, in
its log and in `status`, until you install it there.

For auto-merge (optional, off by default), also enable **Settings > General > Allow
auto-merge** in each repository, and protect its default branch the way you want
reviewed work to land (required reviews, required checks): the factory enables GitHub's
auto-merge, or, when the pull request already meets every requirement, merges it at once
(pinned to the commit whose CI was green); either way branch protections apply, and it
never bypasses them.

## 2. Write the factory settings

One YAML file, by default `~/.funny/factory/config.yaml` (the factory home is
`FUNNY_FACTORY_HOME`, default `~/.funny/factory`; pass another file with `--config`).
The file holds **no secrets**: one that looks like it does is refused.

<!-- factory-settings-example -->

```yaml
github:
  login: octo-owner
  author:
    name: Octo Owner
    email: octo@example.com
model: sonnet
labels:
  ready: ready-for-agent
  in_progress: agent-in-progress
limits:
  concurrency: 2
  daily: 10
auto_merge: false
retry_delay_minutes: 30
sandbox:
  provider: boat
  size: default
projects:
  - path: ~/code/app
    repo: octo-owner/app
    base: main
    check: bun run lint && bun test
  - path: ~/code/tools
    repo: octo-owner/tools
    workspace: worktree
```

### Reference

<!-- factory-settings-reference -->

| Field                  | Required                    | Default                         | Meaning                                                                                                                                                                                    |
| ---------------------- | --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github.login`         | yes                         |                                 | The GitHub user the factory works for. Only issues **opened by** this login, assigned to it or to nobody, are admitted; only its issue body and comments reach the agent (with the title). |
| `github.author.name`   | yes                         |                                 | Author and committer name of the factory's commits.                                                                                                                                        |
| `github.author.email`  | yes                         |                                 | Author and committer email (a valid address).                                                                                                                                              |
| `model`                | yes                         |                                 | The agent's model: `sonnet`, `opus`, `haiku`, or a full model id.                                                                                                                          |
| `labels.ready`         | no                          | `ready-for-agent`               | The label that marks an issue ready. Created in each repository that lacks it.                                                                                                             |
| `labels.in_progress`   | no                          | `agent-in-progress`             | The label a claimed issue carries while its factory run is active. Created when missing.                                                                                                   |
| `limits.concurrency`   | no                          | `2`                             | Factory runs working at once (claiming, implementing, fixing). Runs waiting for CI or to merge do not count.                                                                               |
| `limits.daily`         | no                          | `10`                            | New factory runs started per day (UTC).                                                                                                                                                    |
| `auto_merge`           | no                          | `false`                         | Enable GitHub's auto-merge on green pull requests (squash when the repository allows it). Off: green pull requests are only marked ready.                                                  |
| `retry_delay_minutes`  | no                          | `30`                            | Delay before retrying an infrastructure failure; the second retry waits twice that.                                                                                                        |
| `sandbox.provider`     | if a project uses a sandbox |                                 | The sandbox provider of `@funny/sandbox` (`boat`, `instabox`).                                                                                                                             |
| `sandbox.size`         | no                          | the provider's default          | A size the provider declares.                                                                                                                                                              |
| `projects[].path`      | yes                         |                                 | The project's local checkout (`~` is your home; relative paths are relative to the settings file). Must exist.                                                                             |
| `projects[].repo`      | yes                         |                                 | `owner/name` on GitHub.                                                                                                                                                                    |
| `projects[].workspace` | no                          | `sandbox`                       | `sandbox`: the agent works in a sandbox. `worktree`: in a git worktree on this machine, for [trusted repositories only](#worktree-mode).                                                   |
| `projects[].base`      | no                          | the repository's default branch | The branch pull requests target and runs start from.                                                                                                                                       |
| `projects[].check`     | no                          |                                 | The repository's check command, run (with in-place fixes) before every push. Without one, the pull request says no local checks ran.                                                       |

Unknown fields are refused, and every refusal names the field (`projects.0.repo: expected
owner/name`).

## 3. Give the secrets at startup

Secrets come from the environment or, when the orchestrator is started on a terminal,
from a prompt that does not echo them. The orchestrator holds them in memory: they are removed
from its environment once read, never written to its settings or state store, and replaced
by `[redacted]` in every line it prints. The App's private key never leaves the
orchestrator. What a factory run needs goes into its workspace only: the model key and the
run's App token (in a sandbox, root-only files; in a worktree, the run's own `gh`
configuration), see [the security model](#security-model).

| Variable                           | What                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `FUNNY_FACTORY_MODEL_KEY`          | The model credential (an Anthropic API key): a **dedicated key with a spending limit**.    |
| `FUNNY_FACTORY_APP_ID`             | The Factory App's numeric id.                                                              |
| `FUNNY_FACTORY_APP_PRIVATE_KEY`    | Its private key (the PEM; one line with `\n` escapes is fine). It must sign the App's JWT. |
| `FUNNY_FACTORY_SANDBOX_CREDENTIAL` | The sandbox provider's credential; asked only when a project uses a sandbox.               |

Without a terminal, a missing secret stops the start and names the variable.

## 4. Start it

```bash
bun run factory:start                          # settings from ~/.funny/factory/config.yaml
bun run factory:start -- --config ./factory.yaml
```

It is not part of `bun run dev`. On start it reconciles its state with GitHub and the
workspaces (a factory run interrupted by a stop, even an abrupt one, is neither lost nor
started twice), then ticks every minute: it follows the pull requests of its factory runs
and admits ready issues, oldest first, within the limits. `Ctrl-C` stops admitting and
waits for the factory runs in flight.

To work on an issue: label it `ready-for-agent`. An issue blocked by an open issue
(GitHub's issue dependencies) waits until its blocker closes. A failed factory run hands
the issue back with a comment saying why and both labels removed; add the ready label
again to retry. Infrastructure failures (GitHub, the network, the sandbox, a rate-limited
model) are retried on their own, after `retry_delay_minutes` and then twice that.

## 5. See what it does

### `status`

```bash
bun run factory:status
```

```
acme/app#14                   waiting_ci    https://github.com/acme/app/pull/40  (waiting for CI)
acme/app#12                   failed        -  (agent failure: CI did not pass after 3 fix attempts)
Started today: 2
acme/tools: the Factory App is not installed on this repository; install it there to have its issues worked on
```

One line per factory run, newest first: the issue, the state, the pull request, and why it
waits or failed. The states are `queued` (waiting to start, or to retry), `claiming`,
`working`, `pr_open`, `waiting_ci`, `fixing`, `ready` (marked ready for review),
`merging` (auto-merge enabled, waiting for GitHub), `merged` and `failed`. Then the factory
runs started today, and any watched repository with a problem.

### Event files

Each factory run has `~/.funny/factory/runs/<run id>/events.jsonl`, one JSON object per
line, in the shape funny's ingest API understands:

```json
{
  "event_type": "factory.run_state",
  "request_id": "r-14-1a2b3c4d",
  "thread_id": "r-14-1a2b3c4d",
  "timestamp": "2026-11-13T10:00:00.000Z",
  "data": { "state": "working", "issue_number": 14, "repo": "acme/app" }
}
```

- `factory.run_state`: every state change, with the pull request, the reason and the fix
  attempts when there are;
- `factory.started` / `factory.completed` / `factory.failed`: each step (`implement`,
  `fix`); the end carries the agent session id and, for a failure, whether it was the
  agent's or the infrastructure's;
- `factory.workflow_selected`: whether the repository's workflow or the built-in one ran;
- `factory.cli_message`: every message of the agent (its text, tool calls and results);
- `workflow.*`: the steps of the `factory-issue` workflow.

For a sandbox run, the step's own event file inside the sandbox is mirrored into this one
as it grows.

## 6. Override the workflow per repository

The `implement` step runs the `factory-issue` workflow
(`packages/workflows/defaults/factory-issue.yaml`): implement, run the checks with in-place
fixes, commit, push, open a draft pull request that closes the issue. Its prompt needs no
skills or plugins.

A repository can replace it by committing its own at `.funny/workflows/factory-issue.yaml`
(or `.yml`; `.yaml` wins) **on the base branch**, for example to use its own skills. It is
read from the base branch, never from the run's branch or working tree, so the agent cannot
change what a later step runs. It must be named `factory-issue` and receives the same
inputs (`issue_number`, `issue_title`, `issue_body`, `base`, `branch`, `check_command`,
`pr_body`); its pull request is always opened as a draft. An override that is present but
invalid fails the step as an agent failure naming the file; the default is never used in
its place. Start from a copy of the default.

## Security model

The agent has a shell in its workspace. Assume it can read anything there, and that a
prompt injection can make it try anything that shell allows.

- **The agent can read the Factory App token and the model credential** in its workspace.
  In a sandbox they are in root-only files, but the sandbox user has passwordless `sudo`;
  what keeps them out of the provider's records is that they never go through the sandbox
  create request.
- **What limits a prompt injection** is:
  - the token's scope: one repository (a watched one the App is installed on), the
    permissions above, and **one hour**; the factory renews it while a run works;
  - the **trusted-text rule**: only the configured login's issue body and comments reach
    the prompt; a stranger's comment never does. (The issue title is passed too, and
    people with triage access can edit titles.)
  - your **branch protections**: the factory opens draft pull requests and, with
    auto-merge, merges only through GitHub's auto-merge or a merge GitHub allows under the
    branch's protections, never bypassing required reviews or checks. Protect the branches
    that matter.
- **Use a dedicated model key with a spending limit.** The agent can read and use it; the
  daily limit caps new factory runs, not what one run spends.
- Pull requests, comments and merges appear as the Factory App's bot; commits use the
  configured author.
- A failed factory run's branch and pull request are kept for you to inspect.

### Worktree mode

`workspace: worktree` runs the agent **on your machine**, in a git worktree of your local
checkout, with your user's permissions. The factory gives each run its own home, `gh`
configuration and git configuration, so your own `gh` login, `~/.gitconfig`, credential
helpers and `GH_TOKEN` are neither used nor changed. But the agent shares your machine and
the project's `.git` directory (its hooks run). Use it for **trusted repositories only**,
where you would run the agent by hand.

### Sandbox providers

Boat's `exec` does not turn off its command history, so the encoded secrets written
through it may stay in Boat's records of the sandbox; Instabox's does. The sandbox
template is the funny runner template of the orchestrator's own commit
(`FUNNY_BUILD_COMMIT`, or the pushed HEAD of its checkout), so the orchestrator must run
from a pushed commit. The agent opens pull requests with `gh`, which the template must
provide.
