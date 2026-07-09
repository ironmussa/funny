# Deployment, authentication, and trust boundaries

## Local vs. team mode

funny has two deployment shapes (see [README.md](../../README.md) "Usage" and [INSTALL.md](../../INSTALL.md)):

- **Local mode (default)** — everything runs on one machine: UI, database, git operations, browser sessions, and agent processes. `bunx @ironmussa/funny@latest` or `funny`.
- **Team mode** — a central server (`packages/server`, started as `funny-server`) manages users/projects/memberships and coordinates runners; each team member runs `funny --team <url>`, which starts a runner-only process that connects back over a device-link code (approved from **Settings > Runners** on the central server) or a shared secret/token.

```text
Team member A                    Team member B
┌──────────────────┐            ┌──────────────────┐
│ funny --team URL │            │ funny --team URL │
│  local git        │            │  local git        │
│  local agents      │            │  local agents      │
└────────┬─────────┘            └────────┬─────────┘
         └────────►  Central   ◄─────────┘
                    Server (users, projects, teams)
```

Each member's git operations and agent providers run **on their own machine** — the central server only coordinates; it never touches a team member's filesystem directly (that's what `packages/runtime`, running as the runner, is for).

## Authentication and the admin bootstrap — a stale-doc fix

The app always uses [Better Auth](https://www.better-auth.com/) with cookie-based sessions (`packages/runtime/src/lib/auth.ts`, initialized by the server at startup).

**The in-repo `CLAUDE.md` says:** *"On first startup, a default admin account is created automatically: Username: `admin`, Password: `admin`."*

**That is now stale.** Current behavior, confirmed in `packages/server/src/index.ts` (around the `PORT`/`HOST` setup) and matching [README.md](../../README.md) / [INSTALL.md](../../INSTALL.md):

- On first startup, funny still creates a `admin` user, but the password is **auto-generated per install** and written to `~/.funny/admin-password.txt` (file mode `0600`) — not the static string `admin`.
- The code comment explains why (labeled "Security CR-7"): the auto-generated credentials file is written *after* the server starts listening, so if the server bound to all interfaces by default, there would be a window where a guessable stock `admin`/`admin` password would be reachable from the LAN/internet. The server now defaults to binding `127.0.0.1` (`resolveHost()` in `packages/server/src/lib/host-default.ts`); operators who want remote exposure must set `HOST=0.0.0.0` explicitly.
- Operators can pick the initial password themselves by setting `ADMIN_PASSWORD` before first startup; it's validated by `packages/server/src/lib/password-policy.ts` (at least 10 characters, with uppercase, lowercase, and numeric characters).

**Takeaway for anyone reading `CLAUDE.md`:** don't assume `admin`/`admin` works out of the box — check `~/.funny/admin-password.txt` (or your `ADMIN_PASSWORD` env var) after first startup. This is worth fixing in `CLAUDE.md` itself next time someone touches that file.

Other auth facts that are still accurate:

- Sessions expire after 7 days.
- The Better Auth secret is auto-generated and stored at `~/.funny/auth-secret`.
- Each user only sees their own projects, threads, and automations; WebSocket events are filtered per user.
- SQLite is the default database (`~/.funny/data.db`); PostgreSQL is optional via `DATABASE_URL`.

Auth code map:

- `packages/runtime/src/lib/auth.ts` — the Better Auth instance.
- `packages/server/src/middleware/auth.ts` — validates sessions, sets user context.
- `packages/runtime/src/middleware/auth.ts` — validates the `X-Runner-Auth` shared secret from the server's proxy, falling back to server session validation.
- `packages/client/src/stores/auth-store.ts`, `packages/client/src/lib/auth-client.ts` — client-side session state and Better Auth client (username + admin plugins).

## Per-user git identity

Each user configures their own git identity and GitHub credentials from **Settings > Profile**:

- **Git Name / Email** — used as `--author` on commits and merges.
- **GitHub Personal Access Token** — used as `GH_TOKEN` for push and PR operations.

Tokens are encrypted at rest with **AES-256-GCM**; the encryption key auto-generates on first use at `~/.funny/encryption.key` (mode `0600`). If that file is deleted, previously saved GitHub tokens become unrecoverable — back it up if you rely on it.

## Trust boundaries — runners are not sandboxed

A runner pointed at a remote `TEAM_SERVER_URL` effectively grants that server shell execution in the runner's `$HOME` — git operations, pre-commit hooks, agent CLI spawning, PTY shells, and access to saved GitHub tokens / provider keys. Only connect runners to central servers you trust, and prefer running each runner under a dedicated OS user, VM, or container. Runner-side required configuration:

- `TEAM_SERVER_URL` — required on the runner to connect it to the server.
- `RUNNER_AUTH_SECRET` — required shared secret for runner ↔ server authentication.
- `DATABASE_URL` — optional PostgreSQL connection string on the server (default: SQLite).

See the "Machine B — Runner" section of [INSTALL.md](../../INSTALL.md) for the full walkthrough.

## Desktop packaging

`src-tauri/` wraps the built client (`frontendDist: ../packages/client/dist`) in a Tauri v2 desktop shell and bundles a standalone server binary as an `externalBin` sidecar (`scripts/build-sidecar.ts` compiles `@funny/server` into a per-platform Bun binary at `src-tauri/binaries/funny-server-<triple>`), so the desktop app runs the server as a subprocess rather than requiring a separately-installed Bun/Node runtime. Build with `bun run tauri:build`; the Rust side additionally provides native PTY support (`src-tauri/src/pty.rs`) and permission scoping (`src-tauri/capabilities/`).
