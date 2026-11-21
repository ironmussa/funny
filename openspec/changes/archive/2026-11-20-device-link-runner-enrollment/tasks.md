## 1. Shared protocol types

- [x] 1.1 Add enrollment request/response types to `packages/shared/src/runner-protocol.ts`: `EnrollStartRequest` ({hostname, os}), `EnrollStartResponse` ({userCode, pollToken, expiresIn, interval}), `EnrollPollRequest` ({pollToken}), `EnrollPollResponse` (`{status:'pending'}` | `{status:'approved', runnerId, token, forwardedSecret}`), and an approval lookup type ({userCode, hostname, os, ip, createdAt}).
- [x] 1.2 Re-export the new types where the existing runner-protocol types are surfaced. (Surfaced via the `./runner-protocol` subpath export — consumers import from it directly.)

## 2. Server: enrollment store

- [x] 2.1 Add a `runner_enrollments` table to the shared DB schema (sqlite + pg): `id`, `user_code`, `poll_token_hash`, `status`, `hostname`, `os`, `ip`, `runner_id`, `runner_token`, `approver_user_id`, `failed_attempts`, `created_at`, `expires_at`. Wire it through `db/migrate.ts` (migration `063_runner_enrollments`) and re-export from `server/src/db/schema.ts`.
- [x] 2.2 Create `packages/server/src/services/runner-enrollment-service.ts`: `startEnrollment`, `getByUserCode`, `approve`, `pollByToken`. Short high-entropy `userCode`, long `pollToken` (stored hashed), TTL expiry, single-use credential delivery (`approved` → `consumed`).
- [x] 2.3 On `approve`, register the runner under the approver via existing `runner-manager` registration to mint the `runner_…` bearer, and stage the credential payload (bearer + `process.env.RUNNER_AUTH_SECRET`) for the poll response.
- [x] 2.4 Add a TTL sweep (lazy on each entry point) that drops expired enrollments.

## 3. Server: routes + auth

- [x] 3.1 Add `POST /api/runners/enroll/start` and `POST /api/runners/enroll/poll` handlers in `packages/server/src/routes/runners.ts`.
- [x] 3.2 Add both enroll paths to the public-path allowlist in `packages/server/src/middleware/auth.ts` so they bypass session auth.
- [x] 3.3 Add authenticated `GET /api/runners/enroll/:userCode` (metadata) and `POST /api/runners/enroll/approve` (`{userCode}`); audit each approval/rejection.
- [x] 3.4 Rate-limit `enroll/*` (per-IP and per-user, 60/min) ahead of the generous runner catch-all; reject after N failed approval attempts on a code.

## 4. Runtime (runner): enrollment client

- [x] 4.1 Create `packages/runtime/src/services/runner-enrollment.ts`: run start → print the `userCode` banner → poll until `approved`, returning the credential payload; restart with a fresh code on expiry.
- [x] 4.2 In `team-client.ts`, before `register()`/`resumeSession()`, when `loadRunnerCredentials(serverUrl)` is null AND no `RUNNER_INVITE_TOKEN`/`RUNNER_AUTH_SECRET` is present, invoke the enrollment client and feed its payload into the existing connect path.
- [x] 4.3 Extend `runner-credentials.ts` (`RunnerCredentials` + load/save) with `forwardedSecret`; after enrollment, set `process.env.RUNNER_AUTH_SECRET` from it and persist (mode 0600).
- [x] 4.4 Ensure restart resumes from persisted creds (incl. `forwardedSecret`) without re-enrolling (`resumeSession` loads the secret into the env).

## 5. CLI

- [x] 5.1 In `bin/funny.js`, drop the hard abort that required `RUNNER_AUTH_SECRET` in team mode with no config; fall through to enrollment instead. Keep `--token`-without-`--secret` flagged, and explicit `--secret`/`--token` working unchanged.
- [x] 5.2 Update `--help` text and team-mode messaging to describe the device-link (no-secret) default.

## 6. Client UI

- [x] 6.1 Add a "Link a runner" affordance to `settings/RunnersSettings.tsx`: user-code input → fetch metadata via `GET /api/runners/enroll/:userCode` → confirm dialog showing hostname/os/ip → `POST .../approve`.
- [x] 6.2 Update `ConnectRunnerCard.tsx`: remove the dishonest `--token`-only command; show the zero-config boot command (`bunx funny --team <url>`) and point to "Link a runner".
- [x] 6.3 Add the client API methods in `packages/client/src/lib/api/team.ts` for enroll metadata + approve.

## 7. Tests

- [x] 7.1 Server: enrollment-service unit tests — code/token generation, expiry, approve binds to user, single-use delivery, double-approve rejected, invalid/expired token rejected.
- [x] 7.2 Server: route tests — public start/poll, pending→approved transition, auth required for approve, 404/409 paths.
- [x] 7.3 Runtime: enrollment-client test (start/poll loop + expiry restart) and credentials round-trip incl. `forwardedSecret`.
- [x] 7.4 Regression: the delivered `forwardedSecret` round-trips through forwarded-identity sign/verify (proxied requests verify with the delivered secret).

## 8. Docs

- [x] 8.1 Update `INSTALL.md` to make device-link the documented default for connecting a runner; note SSH (one bland command), PaaS, and the classic flow.

## 9. Phase 2 (Railway one-click)

- [x] 9.1 Add `railway.runner.json` — the runner service config (start `bun run start`, healthcheck `/api/health`); only `TEAM_SERVER_URL` is needed (device-link handles auth). Source of truth for the published "funny-runner" template.
- [x] 9.2 Add a "Deploy on Railway" button to `ConnectRunnerCard`, gated behind `RAILWAY_RUNNER_TEMPLATE_CODE` and prefilling `TEAM_SERVER_URL`. INSTALL.md documents publishing the template + pasting the code.
