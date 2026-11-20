# Design

## Context

- A runner Railway template already exists (`railway.runner.json`, `scripts/start-railway-runner.sh`): outbound-only (`WS_TUNNEL_ONLY=true`), volume at `/data` (`FUNNY_DATA_DIR`), credentials persisted at `$FUNNY_DATA_DIR/runner-credentials.json`.
- Runtime enrollment already supports a header-based token (`RUNNER_INVITE_TOKEN` → `X-Runner-Invite-Token` on `/api/runners/register`), validated in `middleware/auth.ts`. The existing invite token is per-user with a 30-day TTL — too broad for automated provisioning.
- Dedicated runners, project override and scoped data access come from `project-runner-binding` (change `enforce-project-runner-isolation`).
- Railway exposes a public GraphQL API (`backboard.railway.com/graphql/v2`) usable with account, workspace or project tokens; project tokens authenticate via `Project-Access-Token` header, are limited to one project/environment, and (confirmed by the user) can perform every operation needed here: create services and volumes, set variables, deploy, delete.
- Production already runs `funny-runner` on Railway built from this repository with Railpack (`bun run build`) and `railway.runner.json` — no container image exists or is needed.
- The Claude profile auth bug (login/auth check ignoring the project's profile `CLAUDE_CONFIG_DIR`) is fixed in the working tree (`provider-setup.ts`, `system-routes.ts`); profile `configDir` supports `~` via `expandHomePath`.

## Goals / Non-Goals

**Goals:** one-click deploy of a dedicated runner per project on Railway; automatic connection and repo bootstrap; lifecycle (status/redeploy/destroy); a provider seam for future infra.

**Non-Goals:** other providers; deploying the user's application (preview environments); autoscaling or sleep/wake; GitHub App credentials; moving uncommitted local work to the remote runner.

## Decisions

1. **Provider interface on the server** (`RunnerInfraProvider`: `validate`, `provision`, `getStatus`, `redeploy`, `destroy`), returning `ResultAsync` per the neverthrow rule. Railway adapter is a thin GraphQL client (fetch), no Railway CLI dependency on the server. _Alternative_: shelling out to `railway` CLI — rejected: needs the binary in the server image and is harder to test.
2. **Runner built from the funny repo, no Docker image.** The Railway service source is the public GitHub repo (`ironmussa/funny`) with config file `railway.runner.json` (Railpack build + `scripts/start-railway-runner.sh`) — exactly how the production runner is deployed today, so there is zero new artifact to maintain. The source is pinned to the git tag/commit of the running server version so runner and server protocols match; redeploy = point at the new revision. _Alternatives_: a Docker image in GHCR (new Dockerfile + publish pipeline to maintain — rejected per user); `bunx @ironmussa/funny --team` on a generic Bun image (fewer moving parts at deploy time but depends on npm publishing cadence, on system packages like `git` in the base image, and loses the privilege-drop script). Trade-off accepted: each deploy runs a full build on Railway (minutes) instead of pulling an image.
3. **Provisioning token, separate from invite token**: new table `runner_provision_tokens` (hashed token, userId, projectId, deploymentId, expiresAt ≈ 1h, usedAt). Runtime reads `RUNNER_PROVISION_TOKEN`, sends `X-Runner-Provision-Token`; server consumes atomically, creates runner with `role='dedicated'`, sets `projects.runner_id`, returns the long-lived runner token which the runtime persists on the volume (existing behavior). After consumption the variable is useless, so leaving it in Railway is harmless; the adapter also deletes it best-effort.
4. **Token scopes**: on `validate`, detect scope. Account/workspace token → `projectCreate` then the same steps as a project token. Project token (fully capable) → `serviceCreate` (repo source) + `volumeCreate` + `variableCollectionUpsert` + deploy inside that project's environment. Project tokens are the recommended default in the UI (least privilege, one per client). `runner_deployments` records which resource IDs funny created (`createdByFunny` flags) so destroy only deletes those.
5. **Server public URL, auto-detected** in order: (a) `FUNNY_PUBLIC_URL` override if set; (b) `RAILWAY_PUBLIC_DOMAIN`, injected automatically by Railway when the server runs there (the production case — zero config); (c) the origin the user's browser used for the deploy request, accepted only if it is not loopback/private. If none resolves, remote runners are unavailable: the product position is that **remote runners require the hosted (Railway) funny server** — a laptop server would also orphan remote agents when the laptop sleeps. No tunnel, no URL prompt. The chosen URL is verified by the deploy flow (server calls its own `/api/health` through it) before provisioning. _Alternative considered_: using the Railway token to create/read a domain for the server — rejected because the token belongs to the runner's (possibly a client's) Railway project, not the server's; when the server is on Railway, (b) already gives the domain for free.
6. **Status** = merge of Railway deployment status (polled every ~5s while the panel is open / transitional, via the adapter) and funny presence (gRPC session). States: provisioning → building → connecting → online; failed; offline. Pushed to the client over the existing user event stream.
7. **Repo bootstrap**: on first activation of a provisioned runner, server sends `project:bootstrap { projectId, repoUrl }` control command; runner clones into `/data/projects/<projectId>` using the per-operation git credential (project override or user PAT) and reports the path; server writes the assignment `localPath`. Remote project creation stores `projects.path` as a sentinel (`remote:`) and repo URL.
8. **Claude credentials on remote runners — zero per-runner setup.**
   - _Paths_: profile `configDir` inside the user's home is normalized to `~/…` on save (server-side, with a one-time migration of existing profiles); `~` resolves to the runner's `$HOME` (`/data/home/funny`, on the volume).
   - _Headless token_: a profile can hold `CLAUDE_CODE_OAUTH_TOKEN` obtained via `claude setup-token`, run once through the existing PTY/provider-login flow on the general runner (user approves in the browser). The runtime captures the printed token, sends it to the server, which stores it encrypted (`lib/crypto.ts`) in the profile. On every agent spawn the server-resolved profile env carries the token to the executing runner (same per-operation path as `CLAUDE_CONFIG_DIR` today); nothing is written to Railway variables or the volume. Auth failure → `profile.token_invalid` event → single re-approval prompt per profile.
   - _Why not copy `.credentials.json`_: OAuth refresh tokens rotate; two machines sharing one would invalidate each other.
   - _Fallback_: if a profile has no token, the existing profile-aware login runs on the dedicated runner (works, just interactive).
9. **Repo creation for projects without remote**: before any Railway mutation, the deploy flow checks `git remote`; if missing, offers `gh repo create --private` + push on the general runner using the resolved git credential (existing `core/git/github.ts`). Declining aborts with nothing created.
10. **Resources**: v1 uses Railway defaults; the panel shows the plan limits link. Size selection is a later enhancement.

## Risks / Trade-offs

- [Railway API changes / undocumented mutations] → adapter isolated behind the interface with recorded-fixture contract tests; spike task first records the exact mutations and payloads.
- [Leaked Railway token = control of the user's Railway account] → encrypted at rest with `lib/crypto.ts`, never returned, admin audit on use, recommend workspace/project tokens in UI copy.
- [Repo build time on every deploy] → acceptable for v1; deploy panel shows build progress. Image-based deploy can be added later behind the same provider interface.
- [Repo becomes private] → the Railway account must then have GitHub access to it; the adapter surfaces Railway's source-access error.
- [Browser origin is a proxy/alias the runner cannot reach] → self-check through the URL before provisioning; override with `FUNNY_PUBLIC_URL`.
- [Volume loss wipes runner credentials] → runner re-enrollment requires a fresh provisioning token: "Reconnect" action issues one and updates the variable.

## Migration Plan

Additive tables (`infra_connections`, `runner_deployments`, `runner_provision_tokens`) on SQLite + PG. Deploy action disabled with an explanation while no reachable public server URL can be resolved. Rollback: disable the panel; deployed runners keep working as dedicated runners.
