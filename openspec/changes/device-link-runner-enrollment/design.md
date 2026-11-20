## Context

A funny runner is a stateless process that dials out to a central server over
Socket.IO and proxies all persistence back to it. Connecting one today requires
three secrets carried onto the runner machine by hand:

- `TEAM_SERVER_URL` — which server to dial.
- A single-use invite token (`RUNNER_INVITE_TOKEN`) — registers the runner under
  a user; the server consumes it and returns a `runner_…` bearer token, which the
  runner persists to `~/.funny/runner-credentials.json`.
- `RUNNER_AUTH_SECRET` — the **shared** HMAC key for forwarded-identity. The
  server signs `userId|role|org|ts|nonce` with it on every proxied request and
  the runtime verifies with the _same_ key. A mismatch makes every proxied
  request (browse, agents, git) fail.

Two facts from the live code shape this design:

1. **Registration already works with only the invite token.**
   `auth.ts` accepts `X-Runner-Invite-Token` on `POST /api/runners/register`
   with no shared secret (`packages/server/src/middleware/auth.ts:54-70`). The
   shared secret's registration role is restricted to loopback + an explicit
   opt-in.
2. **The shared secret is still needed for proxied traffic.** Forwarded-identity
   signing/verification uses `RUNNER_AUTH_SECRET`
   (`packages/shared/src/auth/forwarded-identity.ts`). That is why `bin/funny.js`
   aborts in team mode without it — even though `ConnectRunnerCard` shows a
   command that omits it. The card is dishonest today.

So the real problem is two-fold: **enrollment ergonomics** (stop hand-carrying a
token) _and_ **secret delivery** (stop hand-carrying the shared secret). A flow
that fixes only the token still leaves the operator pasting a secret.

The target deployment surfaces (from exploration with the user) are **SSH/VM**
and **PaaS (Railway/Fly/Render)** — both headless, neither has a browser on the
runner box. The user's mental model: "point at the server, identify myself, and
the runner configures itself," without storing raw login credentials.

## Goals / Non-Goals

**Goals:**

- A runner boots with **zero configuration** and self-enrolls after a single
  human approval in the funny UI the user is already logged into.
- The operator never copies a token or a shared secret. The runner obtains both
  over the approved, TLS-protected enrollment channel.
- Works identically on SSH/VM (one bland `bunx funny`) and as the substrate for
  a future Railway one-click (no required env vars).
- Make `ConnectRunnerCard` honest — no command the CLI would reject.
- No regression for existing explicit-flag / loopback / invite-token paths.

**Non-Goals:**

- **Per-runner signing keys.** We keep the shared-secret forwarded-identity
  model and deliver that secret to the runner at enrollment. Replacing the global
  HMAC key with per-runner keys (which would close the documented cross-runner
  trust boundary in `forwarded-identity.ts:17-32`) is a separate, larger change.
- **Phase 2 Railway template + "Deploy on Railway" button.** Designed-for here
  (zero-required-env enrollment makes it possible) but not built in this change.
- **Storing the user's funny login on the runner.** Rejected on security grounds
  (long-lived full-account creds at rest in a PaaS env). The device-link approval
  replaces it.
- **Promoting/relaying enrollment across multiple servers** — one server per
  enrollment, matching the existing per-server credentials model.

## Decisions

### D1 — OAuth-device-flow shape, not stored credentials

We model enrollment on the OAuth 2.0 Device Authorization Grant: the device
(runner) gets a short **user code** (for the human) and a long **poll token**
(machine secret), the human approves out-of-band in an already-authenticated
context, and the device polls until it receives credentials.

- _Why over "type funny username/password into the runner":_ no full-account
  credentials ever touch the runner or its env; the granted artifact is a scoped
  runner bearer. Explicit human approval with visible runner metadata is a
  stronger consent signal than a pasted token.
- _Why over "runner serves its own setup page":_ the chosen surfaces (SSH, PaaS)
  have no convenient browser on the box, and a public setup page on an
  unconfigured runner is a hijack surface. Approving in the server UI puts the
  trust decision where the user is already authenticated.

### D2 — Two public endpoints + one authenticated approval

- `POST /api/runners/enroll/start` (public) → `{ userCode, pollToken, expiresIn, interval }`
- `POST /api/runners/enroll/poll` (public, keyed by `pollToken`) → `pending` |
  `{ runnerId, token, forwardedSecret }`
- Approval runs under the **normal session auth** (no new auth path): a settings
  action `POST /api/runners/enroll/approve` taking `{ userCode }`, plus a lookup
  `GET /api/runners/enroll/:userCode` that returns runner metadata for the
  confirm dialog.

The two enroll paths join the existing `PUBLIC_PREFIXES` allowlist in `auth.ts`
(same precedent as `/api/invite-links/register`). Everything that mutates
ownership stays behind the session.

### D3 — Deliver the forwarded-identity secret at approval time

On approval the server registers the runner (reusing `runner-manager`'s existing
registration to mint the `runner_…` bearer) and includes `RUNNER_AUTH_SECRET`
(read from its own `process.env`) in the poll response. The runner loads it into
`process.env.RUNNER_AUTH_SECRET` and persists it.

- _Why:_ it is the smallest change that makes proxied traffic work end-to-end
  without the operator handling the secret. It does not change the trust model —
  every runner already holds the same shared secret today; we just stop making a
  human carry it.
- _Alternative considered (drop forwarded-identity verification for
  tunnel-delivered requests, rely on the bearer-authenticated socket):_ cleaner
  long-term but is effectively the per-runner-signing redesign — out of scope.

### D4 — Enrollment record store

A short-lived enrollment record holds: `userCode`, hashed `pollToken`, `status`
(`pending`/`approved`/`consumed`), `hostname`, `os`, `ip`, `createdAt`,
`expiresAt`, `approverUserId`. Persist as a `runner_enrollments` table via the
shared DB layer (server owns persistence; survives a server restart mid-flow).
The `pollToken` is stored hashed; the `userCode` is short and protected by
expiry + rate limiting rather than secrecy alone.

- _Why a table over in-memory Map:_ enrollment can straddle a server restart and
  the server is the single source of truth for runner ownership; an in-memory map
  would silently drop pending links.

### D5 — Runner-side: a new enrollment module feeding the existing client

`team-client.ts` gains a pre-step: if `loadRunnerCredentials(serverUrl)` and
explicit env both come up empty, call into a new `runner-enrollment.ts` that runs
the start → print code → poll loop, returns the credential payload, and then the
normal `register`/`resumeSession` path continues. `runner-credentials.ts` gains a
`forwardedSecret` field. The CLI (`bin/funny.js`) drops the hard `--secret`/`--token`
abort when nothing is configured and a server URL is known.

How the runner learns the server URL with zero config: precedence is
(a) `--team`/`TEAM_SERVER_URL` if present, else (b) a baked default for the
Railway template (Phase 2), else (c) prompt/stdin. For SSH the one bland command
is `bunx funny --team <url>` (URL only, no secrets) — still a meaningful drop
from three secrets to one non-secret URL.

## Risks / Trade-offs

- **Approval phishing** (a malicious runner shows a code, tricks a user into
  approving it, binding the attacker's runner under the victim) → Mitigation:
  the approval dialog shows hostname/os/originating IP; the user approves their
  own runner. Risk parity with today's invite token (anyone with your token
  registers under you), with a _stronger_ consent signal.
- **User-code brute force against approval** → Mitigation: per-IP and per-user
  rate limiting on approve + sufficient code entropy + short expiry; lock/expire
  after N failed attempts.
- **Poll-token leakage** → Mitigation: long high-entropy token, stored hashed
  server-side, single-use credential delivery, short expiry; transport is TLS.
- **Secret delivered over the wire** → Accepted: the shared secret already lives
  on every runner; delivering it over the approved TLS channel is not a new
  exposure, and the cross-runner trust boundary is already documented and
  accepted. Per-runner keys remain the future hardening.
- **Stale/abandoned enrollments accumulating** → Mitigation: TTL expiry sweep;
  records are small and self-expire.
- **Backward compatibility** → Explicit flags, loopback opt-in, and invite-token
  registration paths are untouched; enrollment only triggers when nothing is
  configured.

## Migration Plan

1. Ship server endpoints + table behind the existing public-prefix mechanism;
   they are additive (no change to existing register/heartbeat).
2. Ship runtime enrollment module + credentials field; gated on "no creds
   resolved," so existing runners keep resuming via their persisted bearer.
3. Ship the client "Link a runner" UI and remove the dishonest command from
   `ConnectRunnerCard`.
4. Update `INSTALL.md` to make device-link the documented default.
5. Rollback: the feature is inert unless a runner is started with no config and
   a user uses the new UI; reverting the client + endpoints restores prior
   behavior. No destructive schema change (new table only).

## Open Questions

- **Code format/lifetime:** exact `userCode` shape (e.g. `WXYZ-1234`), entropy,
  TTL, and poll `interval`/`expiresIn` defaults — pick concrete values in tasks.
- **Approval entry point:** dedicated `enroll/approve` route vs. folding into
  existing `runners`/`profile` settings routes — decide during implementation to
  match current route grouping.
- **Server URL for zero-config Railway (Phase 2):** baked default vs. a template
  variable — deferred to the Phase 2 change.
- **Where the runner surfaces the user code on a headless PaaS box:** stdout/logs
  for v1 (Railway shows logs); a runner status page is a possible later nicety.
