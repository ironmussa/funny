> **Status: SUPERSEDED (2026-10-31), not implemented.** Replaced by `provision-boat-thread-sandboxes`, which implements the shared foundation (infra connections, provider interface, provisioning token, public URL detection, headless Claude token) for per-thread sandboxes. Railway can return later as another provider behind that interface. Archived with `--skip-specs`: none of these requirements shipped.

# Proposal

## Why

Agents currently run wherever the user starts a runner — usually their laptop. Users want each project to run on its own remote compute so many agents can work in parallel without the laptop, and so different projects (often different clients) live in separate deployments. Setting up a runner on Railway today is a manual runbook (`docs/guides/railway-deploy.md`, `railway.runner.json`, device-link approval). This change makes it one action from Project Settings: provide a Railway token, deploy, and the runner connects itself.

## What Changes

- Add a pluggable **runner infrastructure provider** abstraction (validate credentials, provision, status, redeploy, destroy). Only **Railway** is implemented; the UI lists it as the only option and is structured for more.
- **Infrastructure connections**: users store Railway tokens (encrypted at rest) in Settings and pick one from Project Settings; a token can also be added inline from the project.
- **Deploy runner** action in Project Settings → creates (or reuses) a Railway project/service sourced from the funny GitHub repository (same build as today's `funny-runner`, pinned to the server's version), attaches a persistent volume, sets variables, and deploys.
- **Zero-touch connect**: the server mints a single-use, short-lived, project-scoped provisioning token injected as a service variable; the runner registers with it, becomes a `dedicated` runner and is assigned to the project automatically (no device-link approval).
- The runner clones the project's git repository onto its volume; the assignment records that path.
- **Remote project creation**: "Add project → Remote (Railway)" from a repository URL, without a local folder or general runner.
- Lifecycle in Project Settings: live status (provisioning → building → connecting → online / failed / offline), redeploy (upgrade runner version), destroy (with option to keep the Railway resources).
- Server public URL is auto-detected (Railway domain or the URL the user is browsing with); no manual configuration in the common case.
- **No manual configuration** beyond pasting a Railway token once:
  - Claude agent profiles: absolute config paths under the user's home are normalized to `~/…` on save; each Claude profile obtains a long-lived headless token once (`claude setup-token`, one browser approval) that is stored encrypted and delivered per operation to any runner — new runners never need an interactive login.
  - Projects without a git remote: one-click "create private GitHub repo and push" during deploy, using the user's existing GitHub credential.
  - Remote runners require a publicly reachable server (the Railway-hosted server, auto-detected). A localhost server cannot host remote runners; the UI says so instead of asking for configuration.

## Capabilities

### New Capabilities

- `runner-provisioning`: infrastructure connections, provider abstraction, Railway provisioning, zero-touch dedicated-runner enrollment, repository bootstrap, remote project creation, and runner lifecycle management.

### Modified Capabilities

<!-- None. Depends on `project-runner-binding` (change enforce-project-runner-isolation) for dedicated-runner semantics. -->

## Impact

- **Depends on** `enforce-project-runner-isolation` (dedicated runners, project override, scoped data channel).
- Server: new `runner-provisioning` service + Railway adapter (Railway public GraphQL API), infra-connection repository, provisioning-token issuance in the register path, project settings API.
- Shared: schema for `infra_connections`, `runner_deployments`, provisioning tokens (SQLite + PG).
- Runtime: accept `RUNNER_PROVISION_TOKEN` in enrollment; clone-on-assign control command.
- Build/release: no new artifact — the runner service builds from the public repo with `railway.runner.json`; optional `FUNNY_PUBLIC_URL` override.
- Client: Settings > Infrastructure, Project Settings > Runner deploy panel, Add Project remote flow.
- Docs: replace manual steps in `docs/guides/railway-deploy.md` with the in-app flow (keep manual as fallback).
