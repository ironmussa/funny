# Tasks

## 1. Spike: Railway API

- [ ] 1.1 Script against Railway GraphQL with a project token and an account/workspace token: create service from GitHub repo source with `railway.runner.json` pinned to a commit, volume at /data, variables, deploy, read status, delete; record exact mutations/payloads in design.md; verify by a documented successful run against a throwaway Railway project

## 2. Data model & tokens

- [ ] 2.1 Add `infra_connections`, `runner_deployments`, `runner_provision_tokens` to shared schema (SQLite + PG) + migrations; verify migration tests on both dialects
- [ ] 2.2 Provision token issue/consume (hashed, single-use, ~1h TTL, project-bound) in the register path creating a `dedicated` runner and setting `projects.runner_id`; verify tests for success, replay, expiry, wrong project
- [ ] 2.3 Runtime: send `X-Runner-Provision-Token` from `RUNNER_PROVISION_TOKEN` and persist credentials; verify enrollment-client tests

## 3. Provider layer

- [ ] 3.1 `RunnerInfraProvider` interface + registry (ResultAsync); verify unit tests
- [ ] 3.2 Railway adapter (scope detection, provision for both scopes from repo source pinned to server revision, status, redeploy to new revision, destroy only funny-created resources); verify contract tests with recorded fixtures
- [ ] 3.3 Infra connection service with encrypted tokens, never returned, audited use; verify tests incl. redaction in logs

## 4. Provisioning service & API

- [ ] 4.1 Public server URL resolution (override → `RAILWAY_PUBLIC_DOMAIN` → non-private request origin) with self health-check; when unresolved, expose `remoteRunnersUnavailable` with explanation (no URL prompt); verify unit tests for each source and loopback rejection
- [ ] 4.2 Provisioning orchestration (create deployment, mint token, provision, status merge with presence, events to user stream); verify service tests
- [ ] 4.3 Routes: connections CRUD/test, project deploy/status/redeploy/destroy/reconnect; verify route tests incl. ownership checks
- [ ] 4.4 Repo bootstrap control command + runtime clone into `/data/projects/<projectId>` with per-operation credential; verify runtime + server tests incl. clone failure → `failed`
- [ ] 4.5 Normalize profile `configDir` to `~/…` on save + migration for existing profiles; verify unit tests (inside home, outside home, already relative)
- [ ] 4.6 Headless Claude token per profile: run `claude setup-token` through the provider-login PTY on the general runner, capture token, store encrypted in profile, never return to client; verify server + runtime tests incl. redaction
- [ ] 4.7 Deliver profile token per operation as `CLAUDE_CODE_OAUTH_TOKEN` on agent spawn and auth checks; emit `profile.token_invalid` on rejection; verify runtime tests that a runner with no login runs an agent
- [ ] 4.8 Repo creation for projects without remote (`gh repo create --private` + push on general runner) before any Railway mutation; verify tests for accept/decline

## 5. Client

- [ ] 5.1 Settings > Infrastructure (add/test/delete Railway connection, recommend project tokens); shadcn, data-testid, i18n en/es/pt; verify component tests
- [ ] 5.2 Project Settings > Runner: provider select (Railway only), connection select/inline add, Deploy, live status/build progress, Redeploy, Destroy (keep resources option), Reconnect, inline steps for missing Railway connection / profile token approval / repo creation that resume deploy automatically, and the 'remote runners require the hosted server' state; verify component tests
- [ ] 5.3 Add Project > Remote (Railway): repo URL + connection → create + deploy + open when online; verify component/integration test
- [ ] 5.4 Agent profile UI: 'Enable on remote runners' action that runs the one-time approval and shows token status (never the value); verify component test

## 6. Docs & integration

- [ ] 6.1 Update `docs/guides/railway-deploy.md` and openwiki with the in-app flow, URL auto-detection and profile paths; verify docs reviewed
- [ ] 6.2 End-to-end check against a real Railway project: deploy runner for a project with a project token, runner online without approval, repo cloned, project created without remote gets a GitHub repo, agent runs with the profile's headless token and no login on the runner, destroy removes funny-created resources; verify by recorded run notes
