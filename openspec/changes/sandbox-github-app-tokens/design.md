# Design

## Context

See proposal.md for the motivation. Facts that shape the approach:

- **Already in place, kept:** the data channel refuses GitHub secrets to sandbox runners (`server/services/data-scope.ts`, `touchesGithubSecret`: `data:get_github_token`, `data:get_provider_key` for `github`, `data:update_profile` with a `githubToken`). Without a token git adds no credential of its own (`core/git/base.ts`), so whatever helper the checkout configures is used.
- **Also in place:** a sandbox runner is bound to exactly one thread (`runner-scope.sandboxThreadOfRunner`), and data ops can be limited to "sandbox runners only, own thread" (`SANDBOX_ONLY_TYPES` in `data-scope.ts`, added for the retired capability op).
- **The GitHub App exists:** `funny-sandboxes-ironmussa`, App ID 5690396, installed on `ironmussa` with selected repositories. Repository permissions: contents, pull requests, issues, workflows read/write; Actions, checks, commit statuses read; metadata read.
- **An installation covers an account, not a user.** The server can mint a token for any repository the installation was given, whoever the funny user is. funny projects point at a repository the user chose, so the App alone does not prove that the thread owner may use that repository.
- **gh reads its token per invocation** from `GH_TOKEN` or from `hosts.yml` in its config directory; `gh auth git-credential` makes git use the same token. The agent's environment is fixed when it starts, so a token that rotates hourly cannot live in `GH_TOKEN`.

## Goals / Non-Goals

**Goals:**

- `git` and `gh` work in a sandbox exactly as on a laptop, for the thread's repository.
- Whatever leaks from a sandbox is worth at most one repository, the owner's own level of access to it, for at most an hour.
- The App's private key never leaves the server.

**Non-Goals:**

- Gating pushes or PRs started by a steer sharee (the token is in the sandbox, so the server cannot gate it). Branch protection is GitHub's job (rulesets).
- Actions shown as the user instead of the App bot (user-to-server tokens).
- Repositories outside GitHub, or without the App installed (no GitHub credential in that case).

## Decisions

### 1. One App per deployment, connected through GitHub's App manifest flow

A key cannot be shared between deployments (it mints tokens for every installed repository), so each funny server creates its own App. To keep that a one-click step:

- `POST /api/settings/github-app/manifest` (admin) returns the GitHub URL (`https://github.com/settings/apps/new` or `https://github.com/organizations/<org>/settings/apps/new`) and a manifest: name, homepage, the permissions from decision 3, `hook_attributes.active: false`, `public: false`, and `redirect_url = <public server URL>/api/settings/github-app/callback`. It also returns a `state`: random, single-use, valid for 10 minutes, bound to the admin's user id and stored server-side. The client submits the manifest to GitHub as a form POST.
- `GET /api/settings/github-app/callback?code&state` (admin session): checks and consumes the state, calls `POST https://api.github.com/app-manifests/{code}/conversions` (no auth; the code is single-use and expires in an hour), and stores `{ id, slug, client_id, owner }` plus the `pem` encrypted with `lib/crypto.encrypt` in `instance_settings` (`github_app`, `github_app_private_key`), as SMTP settings are stored. The webhook secret and client secret are not kept (no webhook, no OAuth). Then it redirects to the settings page.
- `GET /api/settings/github-app` (admin): `{ configured, source: 'environment' | 'database' | 'none', appId, slug, owner, installUrl }`, never the key. `DELETE` removes the stored App.
- `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` (PEM, `\n`-escaped accepted), when set, take precedence, read through `server/lib/server-secrets.ts`.
  _Alternatives:_ environment variables only (works for this deployment, but every self-hoster would have to create the App by hand and paste a PEM into their platform); one shared App run by the funny maintainers (would require a central token service holding a key that can reach every user's repositories; rejected for self-hosted).

### 2. Minting: JWT → installation for the repository → scoped token, cached

A server service (`services/github-app/`, `Result`-returning):

- Sign the App JWT with `node:crypto` (RS256, `iat = now - 60s`, `exp = now + 9m`, `iss = appId`). No new dependency.
- `GET /repos/{owner}/{repo}/installation` gives the installation id (cached 10 min; a 404 means not installed).
- `POST /app/installations/{id}/access_tokens` with `repositories: [name]` and an explicit `permissions` map (decision 3) gives a token and `expires_at`.
- The token is cached per (repository, permission set) and reused until 10 minutes before it expires, so many requests do not mint many tokens.

### 3. The owner must have access to the repository: checked with the owner's PAT, on the server

Before minting for a thread, the server asks GitHub what the **thread owner** may do on the repository: `GET /repos/{owner}/{repo}` with the owner's PAT (project override, then the user's key; it never leaves the server) and reads `permissions`. The minted token's permissions are the App's permissions capped by the owner's level:

- `push` (or more) → the App's write permissions.
- `pull` only → `contents`, `pull_requests`, `issues` read; no workflows.
- No access, no PAT, or a lookup error → no token.
  The result is cached for 10 minutes per (owner, repository).
  _Why:_ without it, any funny user could point a project at a repository the installation covers and receive a write token for it. _Alternative:_ link each user's GitHub identity through OAuth and check collaborators. That is the cleaner long-term path, but needs a new flow. The PAT is already configured for every user who pushes today.

### 4. Delivery: a sandbox-only data op

`runner.v2` op `GetGithubAppToken { thread_id }` (replacing the unreleased `GetGitCapability`, same field number), mapped to `data:get_github_app_token` and listed in `SANDBOX_ONLY_TYPES` with rule `refs`. So only the thread's own sandbox runner can ask, and only for its thread. The handler also requires the thread not archived and its sandbox usable, the same predicate the LLM proxy uses. The response is `{ token, expiresAt, repo }` or `{ error: 'not-installed' | 'no-access' | 'not-configured' }`.

### 5. Runtime: gh config + git credential helper + refresh loop

On a sandbox runner, a `sandbox-github-auth` service:

- Fetches the token, writes `hosts.yml` under the runner user's `GH_CONFIG_DIR` (`github.com: { oauth_token, user: x-access-token, git_protocol: https }`, mode 0600), and sets `credential.https://github.com.helper` to `!gh auth git-credential` in the user's global git config. git and every gh invocation read the current token.
- Renews it with an Effect schedule (every 45 minutes, and 5 minutes before `expiresAt`), with bounded retry/backoff on errors, interrupted when the runner stops.
- The agent environment carries no `GH_TOKEN`, so gh never uses a stale value.
- The checkout clone (`sandbox-checkout`) uses the same token in the URL for the clone only, then strips it, as it does today with the PAT.

### 6. Retire the broker work

The broker route, the capability table (migration 093, never released) and the receive-pack parser are removed from the branch, and the `sandbox-git-credential-broker` change is dropped. The data-scope rule from it (group 1) stays.

## Risks / Trade-offs

- **[A leaked token is still a write token for one repository for an hour]** → That is the accepted floor: it is what the thread may already do. GitHub rulesets protect the default branch.
- **[A steer sharee can act on the repository through the agent without the owner's approval]** → Documented in the share dialog for sandbox threads ("can push to <repo> through the agent"). A server-side gate is not possible with a token in the sandbox.
- **[Pushes and PRs appear as `funny-sandboxes-ironmussa[bot]`]** → Commits keep the user's git author. User-to-server tokens can come later.
- **[The owner check relies on the owner's PAT existing]** → A user without a PAT gets no sandbox GitHub access (same as today's push), and the thread says so.
- **[App private key compromise]** → It reaches every installed repository. It is a server secret like the encryption keyring; rotate it from the App settings if exposed.

## Migration Plan

1. For this deployment, set `GITHUB_APP_ID=5690396` and `GITHUB_APP_PRIVATE_KEY` on the server (Railway) before deploying (the App was created by hand). New deployments use Connect GitHub instead.
2. Deploy server and runner template together. Running sandboxes pick up the App token at their next agent start; until then they have no GitHub credential (they already lost the PAT with the data-scope rule).
3. Rollback: unset the App variables. Sandboxes then have no GitHub credential. The PAT is never restored to sandboxes.
