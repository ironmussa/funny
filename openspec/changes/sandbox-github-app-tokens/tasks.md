# Tasks

## 1. Keep the token out of sandboxes (done on branch `feat/sandbox-git-broker`)

- [x] 1.1 Refuse GitHub secrets to sandbox runners in `data-scope.ts` (`get_github_token`, `get_provider_key github`, `update_profile` with `githubToken`); verified by `thread-sandbox-isolation.test.ts`
- [x] 1.2 No token → git adds no credential of its own; verified by `core/__tests__/git-remote-credentials.test.ts`

## 2. Retire the broker

- [x] 2.1 Remove the broker route, the capability service and table (migration 093, schemas, test DB), the receive-pack parser and their tests from the branch; verify `bun run lint`, `bun run typecheck` and the schema-drift test pass and nothing references them
- [x] 2.2 Rename the protocol op `GetGitCapability` → `GetGithubAppToken` (same field number, unreleased), regenerate, and rename `data:get_git_capability` → `data:get_github_app_token` across runtime, server mapping, `SANDBOX_ONLY_TYPES` and tests; verify the adapter, golden and isolation tests pass

## 3. GitHub App service (server)

- [x] 3.1 Read `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` (PEM, `\n`-escaped accepted) in `services/github-app/app-config.ts` (environment injected; `server-secrets.ts` is for generated secrets); verify tests for present, missing and malformed values
- [x] 3.2 Sign the App JWT with `node:crypto` (RS256, iat-60s, exp+9m, iss); verify a test that the JWT verifies with the public key and has the right claims
- [x] 3.3 Find the installation for a repository and mint a token restricted to that repository with an explicit permission map, with caching (installation 10 min; token until 10 min before expiry); verify tests against a fake GitHub API: not installed, minted, cached, re-minted near expiry, request body has exactly one repository
- [x] 3.4 Cap the permissions by the thread owner's access to the repository, checked with the owner's PAT on the server (push → write set; pull → read set; none, no PAT or error → no token), cached 10 min; verify tests for each level and that the PAT is never in any response

## 4. Connect GitHub (App manifest flow)

- [x] 4.1 Store and read the App config: `instance_settings` (`github_app` JSON, `github_app_private_key` encrypted with `lib/crypto`), environment taking precedence; never return the key; verify tests for database, environment and none, and that no API response contains the key
- [x] 4.2 `POST /api/settings/github-app/manifest` (admin): manifest with the sandbox permissions, no webhook, private, redirect to the callback; single-use 10-minute state bound to the admin; personal or organization target URL; verify route tests (admin only, manifest content, state stored)
- [x] 4.3 `GET /api/settings/github-app/callback` (admin): consume the state, convert the code with GitHub, store the App; refuse missing, foreign, reused or expired state; verify tests against a fake GitHub API for each case
- [x] 4.4 `GET` / `DELETE /api/settings/github-app` (admin): status with source and install URL; delete stored credentials; verify route tests
- [x] 4.5 Preferences UI (admin): a GitHub App page with Connect (account or organization), status, _Install on repositories_ link and Disconnect; shadcn components with `data-testid`s; verify component tests for not connected, connected from database, and from environment (no Connect, no Disconnect)

## 5. Delivery to the sandbox runner

- [x] 5.1 Handler for `data:get_github_app_token`: own sandbox thread only, thread not archived, sandbox usable; returns `{ token, expiresAt, repo }` or a typed error (`not-configured`, `not-installed`, `no-access`); verify isolation tests (own thread ok, other thread / general runner refused) and handler tests for each error
- [x] 5.2 Audit each issuance (thread, owner, repository, permission set; never the token); verify the audit test

## 6. Runtime: git and gh in the sandbox

- [x] 6.1 `sandbox-github-auth` service: write gh `hosts.yml` (0600, multi-account format, `config.yml` marked `version: "1"` so gh does not migrate through GitHub) and set the global git credential helper to `gh auth git-credential`; no `GH_TOKEN` in the agent env; verify tests with a temp HOME that `gh auth token` and `git credential fill` return the App token
- [x] 6.2 Refresh with an Effect schedule (45 min and 5 min before expiry), bounded retry with backoff, interrupted on runner stop; verify tests for renewal, retry exhaustion and interruption during backoff
- [x] 6.3 Clone the sandbox checkout with the App token (URL only for the clone, then stripped) instead of the owner PAT; when no token is available, clone public repos anonymously and report a clear thread message for private ones; verify `sandbox-checkout` tests
- [x] 6.4 Thread message when the App is not installed or the owner lacks access, naming the fix; verify a test for each case

## 7. Documentation

- [x] 7.1 Document the App setup (Connect GitHub in Settings, installing on selected repositories, and the two server variables as the alternative) in `docs/guides/railway-deploy.md` and the sandbox section of `openwiki`, and note in `CLAUDE.md` that sandboxes get repository-scoped App tokens, never the owner's PAT; verify `bun run lint`
- [x] 7.2 Note in the share dialog for sandbox threads that a steer sharee can act on the repository through the agent; verify a component test

## 8. Integration

- [ ] 8.1 Set the App variables on the production server, deploy server and runner, and on a real sandbox of `ironmussa/funny` run `gh auth status`, `gh pr list`, `gh issue list`, `git fetch`, `git push` of a branch and `gh pr create`; check that `env`, gh config and `.git/config` hold no PAT, and that the token is refused for another repository
- [ ] 8.2 Keep a sandbox running more than an hour and check `gh` and `git` still authenticate
- [ ] 8.3 Run `bun run lint`, `bun run typecheck` and the server, runtime and client suites
