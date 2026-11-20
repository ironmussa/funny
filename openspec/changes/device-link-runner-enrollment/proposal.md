## Why

Connecting a runner to an external server today is hostile to anyone who isn't
SSH-ing into a box: the operator must hand-carry **three** machine secrets
(`TEAM_SERVER_URL`, the shared `RUNNER_AUTH_SECRET`, and a single-use invite
token) onto the runner via the CLI or a PaaS env-var panel. On Railway/Fly/Render
there is no shell to run a command, so the only path is pasting env vars by hand
— and the shared secret has to travel out-of-band and match exactly on both
sides or every proxied request silently 500s.

Worse, the UI already lies about this: `ConnectRunnerCard` shows
`bunx funny --team <url> --token <token>` with no `--secret`, but the CLI aborts
in team mode without `RUNNER_AUTH_SECRET`. We want enrolling a runner to feel
like linking a device: boot it with **zero configuration**, approve it once from
the funny UI you're already logged into, and have it configure itself.

## What Changes

- **New enrollment flow: device-link.** A runner started with no credentials
  (no creds file, no `TEAM_SERVER_URL`/token/secret) no longer errors. It learns
  its server URL, generates a short human code, and polls an unauthenticated
  enrollment endpoint until a logged-in user approves it. On approval the server
  hands back everything the runner needs (runner id, bearer token, and the
  forwarded-identity secret), which the runner persists — so the human never
  copies a secret or token.
- **New public endpoint pair (OAuth-device-flow shaped):**
  - `POST /api/runners/enroll/start` — runner submits its hostname/os, gets back
    a short `userCode` (shown to the human) and a long `pollToken` (kept by the
    runner). Rate-limited, short-lived.
  - `POST /api/runners/enroll/poll` — runner polls with the `pollToken`; returns
    `pending` until approved, then the registration payload (runner id, bearer,
    forwarded-identity secret).
- **New authenticated approval action.** Settings ▸ Runners gains a "Link a
  runner" affordance: the user enters the `userCode`, sees the runner's
  hostname/os/IP, and approves — binding that enrollment to their account.
- **`ConnectRunnerCard` becomes honest.** It stops showing a command with a
  missing `--secret`. Instead it surfaces two boot paths that both end in the
  device-link approval: a bare command (`bunx funny`, no flags) for any box, and
  a placeholder for the Railway one-click (Phase 2).
- **CLI no longer requires `--secret`/`--token` to start.** With nothing
  configured, `bin/funny.js` enters enrollment mode instead of aborting. Explicit
  flags still work (and still skip enrollment) for backward compatibility.
- **Persisted credentials extended.** `runner-credentials.json` also stores the
  forwarded-identity secret delivered at enrollment, so restarts stay transparent.
- **Phase 2 (separate, optional): Railway template.** A `railway.json` for the
  runtime + a "Deploy on Railway" button in `ConnectRunnerCard`, requiring zero
  required env vars because device-link handles all config post-boot. Scoped out
  of this change's required tasks; tracked as a follow-up.

Out of scope (explicit future hardening): **per-runner signing keys.** This
change keeps the existing shared-secret forwarded-identity model and simply
delivers that secret over the approved (TLS) enrollment channel instead of
out-of-band. Replacing the shared HMAC key with per-runner keys — which would
close the documented cross-runner trust boundary — is a larger follow-up.

## Capabilities

### New Capabilities

- `runner-enrollment`: device-link enrollment of a runner against an external
  server. Covers the unauthenticated start/poll endpoints, the short-code +
  poll-token model and their lifetimes, the authenticated approval action bound
  to the approving user, delivery and persistence of the runner's credentials
  (bearer + forwarded-identity secret) on approval, the runner-side boot/poll
  loop and credential persistence, and the CLI's no-config startup behavior.

### Modified Capabilities

<!-- None. There are no existing capability specs in openspec/specs/ today, so
     the current runner registration / ConnectRunnerCard behavior being changed
     is documented inline in design.md against the live code, not as a delta. -->

## Impact

- **Server:**
  - `packages/server/src/routes/runners.ts` — new `enroll/start` + `enroll/poll`
    handlers; new approval handler (or under `profile`/`runners` settings routes).
  - `packages/server/src/middleware/auth.ts` — add the two enroll paths to the
    public-prefix allowlist; approval action runs under the normal session auth.
  - `packages/server/src/services/runner-manager.ts` (or a new
    `runner-enrollment-service.ts`) — enrollment record store (userCode,
    pollToken, status, hostname/os, expiry, approverUserId), and minting the
    registration payload (incl. `process.env.RUNNER_AUTH_SECRET`) on approval.
  - DB: an `runner_enrollments` table (or reuse of an existing ephemeral store).
- **Runtime (runner):**
  - `packages/runtime/src/services/team-client.ts` + a new
    `runner-enrollment.ts` — when no credentials resolve, run the enroll/poll
    loop, surface the `userCode` (stdout + a minimal status), then continue into
    the normal register/resume path with the delivered creds.
  - `packages/runtime/src/services/runner-credentials.ts` — persist the
    forwarded-identity secret alongside the bearer.
- **CLI:** `bin/funny.js` — drop the hard `--secret`/`--token` requirement;
  enter enrollment mode when nothing is configured.
- **Client:** `packages/client/src/components/ConnectRunnerCard.tsx` and
  `settings/RunnersSettings.tsx` — the "Link a runner" code-entry + approval UI;
  remove the dishonest command.
- **Shared:** `packages/shared/src/runner-protocol.ts` — request/response types
  for enroll start/poll and the approval payload.
- **Docs:** `INSTALL.md` — the device-link path as the default; SSH and Railway
  notes.
