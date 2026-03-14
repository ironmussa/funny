# funny — Installation & Configuration Guide

## Prerequisites

- **[Bun](https://bun.sh)** >= 1.3.5
- **[Claude CLI](https://claude.ai/code)** installed and authenticated
- **Git** installed and configured

---

## Configuration Scenarios

### 1. Quick Start with `bunx` (no installation)

The simplest way to run funny. No cloning or installing required.

```bash
bunx @ironmussa/funny@latest
```

Open `http://localhost:3001` in your browser.

Default credentials on first startup:
- **Username:** `admin`
- **Password:** `admin` *(change immediately)*

**Environment variables (all optional for this mode):**

```env
# .env  (place in your working directory, or pass inline)

# Port and host
PORT=3001
HOST=127.0.0.1

# Database — SQLite by default, no config needed.
# Switch to PostgreSQL if needed:
# DATABASE_URL=postgresql://user:password@host:5432/funny

# Path to the Claude CLI binary (auto-detected if omitted)
# CLAUDE_BINARY_PATH=/usr/local/bin/claude
```

Pass inline without a file:

```bash
PORT=8080 DATABASE_URL=postgresql://... bunx @ironmussa/funny@latest
```

**Data is stored at `~/.funny/`:**

```
~/.funny/
├── data.db           # SQLite database (omitted when using PostgreSQL)
├── auth-secret       # Session secret
└── encryption.key    # AES-256-GCM key for token encryption
```

---

### 2. Server + Runner on the Same Machine

This is the standard self-hosted deployment. One machine runs everything: web UI, database, and Claude agent runner.

#### Option A — Install globally

```bash
bun install -g @ironmussa/funny
funny
```

#### Option B — From source

```bash
git clone https://github.com/ironmussa/funny.git
cd funny
bun install
bun run build
bun start
```

#### Option C — Development mode (hot reload)

```bash
git clone https://github.com/ironmussa/funny.git
cd funny
bun install
bun run dev       # starts server (port 3001) + client (port 5173) concurrently
```

**Environment variables:**

```env
# .env  (place at the repo root, or export before running)

# ── Network ──────────────────────────────────────────────
PORT=3001
HOST=127.0.0.1          # Use 0.0.0.0 to expose to the local network

# ── Database ─────────────────────────────────────────────
# SQLite (default — no config needed):
# DB_MODE=sqlite

# PostgreSQL (optional):
# DATABASE_URL=postgresql://user:password@host:5432/funny

# ── Claude CLI ───────────────────────────────────────────
# Auto-detected if omitted:
# CLAUDE_BINARY_PATH=/usr/local/bin/claude

# ── Observability (optional) ─────────────────────────────
# OTLP_ENDPOINT=http://localhost:4000
```

**Architecture:**

```
Your Machine
┌──────────────────────────────────────┐
│  funny (port 3001)                   │
│  ┌────────────┐  ┌────────────────┐  │
│  │  Web UI    │  │  Runner        │  │
│  │  (served   │  │  (Claude CLI   │  │
│  │  by server)│  │  + git ops)    │  │
│  └────────────┘  └────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │  SQLite (~/.funny/data.db)     │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

---

### 3. Client, Server, and Runner on Separate Machines

This topology separates concerns across multiple machines. Useful for teams where a central server coordinates work and individual developers (or dedicated machines) run the Claude agents.

**Architecture:**

```
Developer / Browser
┌──────────────────┐
│  Browser         │
│  http://runner:  │
│  3001            │
└────────┬─────────┘
         │
         ▼
Runner Machine (Machine B)
┌──────────────────────────────┐
│  funny --team <central-url>  │
│  ┌──────────┐ ┌───────────┐  │
│  │ Web UI   │ │ Runner    │  │
│  │          │ │ (Claude   │  │
│  │          │ │ CLI, git) │  │
│  └──────────┘ └─────┬─────┘  │
└────────────────────┼─────────┘
                     │ WebSocket tunnel
                     ▼
Central Server (Machine A)
┌──────────────────────────────┐
│  funny-server --port 3002    │
│  ┌──────────────────────┐    │
│  │ Users, projects,     │    │
│  │ memberships,         │    │
│  │ runner coordination  │    │
│  └──────────────────────┘    │
│  ┌──────────────────────┐    │
│  │ Database (SQLite or  │    │
│  │ PostgreSQL)          │    │
│  └──────────────────────┘    │
└──────────────────────────────┘
```

> **Note:** Runners communicate with the central server over a WebSocket tunnel, so they can be behind NAT. The runner only needs outbound access to the central server — no inbound ports required on the runner machine.

---

#### Machine A — Central coordination server

Handles authentication, user management, and project coordination. Does **not** execute agents.

```bash
bun install -g @ironmussa/funny
funny-server --port 3002
```

**Environment variables for the central server:**

```env
# .env  (on Machine A)

# ── Network ──────────────────────────────────────────────
PORT=3002
HOST=0.0.0.0             # Bind to all interfaces so runners can reach it

# ── CORS ─────────────────────────────────────────────────
# List all runner/client origins that will connect to this server.
# Comma-separated. Required when runners are on different machines.
CORS_ORIGIN=http://runner-a.local:3001,http://runner-b.local:3001

# ── Runner authentication ─────────────────────────────────
# Shared secret used by runners to authenticate with this server.
# Generate with: openssl rand -hex 32
RUNNER_AUTH_SECRET=<generate-with-openssl-rand-hex-32>

# ── Database ─────────────────────────────────────────────
# SQLite (default):
# (no config needed — stored at ~/.funny-server/central.db)

# PostgreSQL (recommended for production):
# DATABASE_URL=postgresql://user:password@host:5432/funny_central

# ── Data directory (optional) ────────────────────────────
# FUNNY_CENTRAL_DATA_DIR=~/.funny-server

# ── Logging ──────────────────────────────────────────────
# LOG_LEVEL=info          # debug | info | warn | error
```

On first start, a default admin account is created (`admin` / `admin`). The admin creates additional user accounts from the admin panel.

---

#### Machine B — Runner (agent executor)

Each runner machine has its own local git repos and Claude CLI installation. Runners connect to the central server and receive tasks from it.

```bash
bun install -g @ironmussa/funny
funny --team http://<central-server-ip>:3002
```

The runner machine needs:
- Claude CLI installed and authenticated
- Git installed and configured
- Access to your project repositories

**Environment variables for the runner:**

```env
# .env  (on Machine B)

# ── Team mode — required to activate runner mode ──────────
# URL of the central server. This is what activates team/runner mode.
# Equivalent to passing --team <url> on the command line.
TEAM_SERVER_URL=http://<central-server-ip>:3002

# ── Runner authentication ─────────────────────────────────
# Must match the RUNNER_AUTH_SECRET set on the central server.
RUNNER_AUTH_SECRET=<same-secret-as-central-server>

# ── Network ──────────────────────────────────────────────
PORT=3001
HOST=0.0.0.0             # Expose UI to browsers on the network (optional)

# ── Claude CLI ───────────────────────────────────────────
# Auto-detected if omitted:
# CLAUDE_BINARY_PATH=/usr/local/bin/claude

# ── Direct HTTP fallback (optional) ──────────────────────
# If the runner is reachable directly by the central server (not behind NAT),
# set this so the server can also call it over HTTP instead of the WS tunnel.
# RUNNER_HTTP_URL=http://<runner-ip>:3001

# ── Database ─────────────────────────────────────────────
# The runner keeps its own local SQLite by default.
# Only set DATABASE_URL if the runner should share a PostgreSQL DB.
# DATABASE_URL=postgresql://user:password@host:5432/funny
```

---

#### Machine C — Client (browser only)

The web UI is served by each runner machine. Users open a browser pointing to `http://<runner-ip>:3001` — no environment variables or installation required on the client machine.

If you are building the client separately and deploying it to a CDN or separate web server, configure the backend URL:

```env
# .env  (packages/client — only for separate client builds)

# Backend server URL (the runner or central server address)
VITE_SERVER_URL=http://<runner-ip>:3001

# Client dev server settings (development only)
# VITE_PORT=5173
# VITE_HOST=localhost
```

---

#### How runner registration works

When a runner starts with `TEAM_SERVER_URL` set, it automatically registers with the central server:

1. POSTs to `/api/runners/register` with `{ name, hostname, os }` and the `RUNNER_AUTH_SECRET` as an `X-Runner-Auth` header.
2. The server responds with a `{ runnerId, token }`. The runner stores this token and uses it for all subsequent requests (heartbeat every 15 s, task polling every 5 s, WebSocket auth).
3. The runner connects to `/ws/runner` on the central server, authenticates with its token, and begins receiving task dispatches.

Runners are **machine-scoped, not user-scoped** — a runner represents a machine. After registration, an admin associates each runner with the appropriate user's projects from the central server admin panel (`/admin/runners`).

#### Multi-runner setup — one runner per user/machine

All runners share the same `RUNNER_AUTH_SECRET` but each gets its own unique `runnerId` on registration. The admin then maps each runner to its owner.

```bash
# Developer A — their workstation
TEAM_SERVER_URL=http://central:3002 RUNNER_AUTH_SECRET=shared-secret funny

# Developer B — their workstation
TEAM_SERVER_URL=http://central:3002 RUNNER_AUTH_SECRET=shared-secret funny

# Dedicated CI machine
TEAM_SERVER_URL=http://central:3002 RUNNER_AUTH_SECRET=shared-secret funny
```

**Runner data stored on the central server:**

| Field             | Value                                     |
|-------------------|-------------------------------------------|
| `id`              | Auto-generated unique ID                  |
| `name`            | `<hostname>-funny`                        |
| `hostname`        | Machine hostname                          |
| `os`              | `linux` / `darwin` / `win32`             |
| `token`           | Bearer token for authenticated requests   |
| `status`          | `online` / `offline` / `busy`            |
| `userId`          | Associated user (assigned by admin)       |
| `registeredAt`    | Registration timestamp                    |
| `lastHeartbeatAt` | Updated every 15 s (offline after 60 s)  |

---

### 4. Database Configuration

#### SQLite (default)

No configuration needed. SQLite files are created automatically on first run.

- `funny` (runner): `~/.funny/data.db`
- `funny-server` (central server): `~/.funny-server/central.db`

Recommended for single-machine or small team deployments.

#### PostgreSQL

Recommended for production, high availability, or teams sharing a single database.

**Step 1 — Provision a PostgreSQL database**

```bash
createdb funny_production
```

**Step 2 — Set the connection URL**

```env
# Option 1 — full URL (recommended)
DATABASE_URL=postgresql://user:password@host:5432/funny_production

# Option 2 — individual variables
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=secret
DB_NAME=funny_production

# Option 3 — standard PG* variables (auto-set by Railway, Heroku, Render, etc.)
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=secret
PGDATABASE=funny_production
```

**Step 3 — Start funny**

```bash
# bunx
DATABASE_URL=postgresql://... bunx @ironmussa/funny@latest

# Global install
DATABASE_URL=postgresql://... funny

# From source
DATABASE_URL=postgresql://... bun start
```

**Step 4 — Push the schema** (first time only, from source)

```bash
bun run db:push
```

**Connection string examples:**

```bash
# Local
DATABASE_URL=postgresql://localhost/funny

# With credentials
DATABASE_URL=postgresql://myuser:mypassword@localhost:5432/funny_production

# Remote with TLS (Neon, Supabase, Railway, etc.)
DATABASE_URL=postgresql://user:pass@db.example.com/funny?sslmode=require
```

**SQLite vs PostgreSQL:**

|                     | SQLite                          | PostgreSQL                        |
|---------------------|---------------------------------|-----------------------------------|
| Setup               | Zero-config                     | Requires a running Postgres server |
| Best for            | Single user, small team         | Large teams, production, HA        |
| Data location       | `~/.funny/data.db`              | Your Postgres server               |
| Backup              | Copy the `.db` file             | Standard Postgres backup tools     |
| Concurrent writers  | Limited                         | Full concurrent access             |

---

## Environment Variables Reference

### `funny` (runner + UI)

| Variable             | Description                                              | Default        | Required            |
|----------------------|----------------------------------------------------------|----------------|---------------------|
| `PORT`               | Port to listen on                                        | `3001`         | No                  |
| `HOST`               | Host to bind to                                          | `127.0.0.1`    | No                  |
| `TEAM_SERVER_URL`    | Central server URL — **activates team/runner mode**      | —              | Only in team mode   |
| `RUNNER_AUTH_SECRET` | Shared secret for runner ↔ server authentication         | Auto-generated | Yes in team mode    |
| `RUNNER_HTTP_URL`    | Runner's own HTTP URL (enables direct HTTP fallback)     | —              | No                  |
| `LOCAL_RUNNER`       | Set to `false` to disable the in-process runner          | `true`         | No                  |
| `DATABASE_URL`       | PostgreSQL connection URL                                | SQLite         | No                  |
| `CORS_ORIGIN`        | Allowed CORS origins (comma-separated)                   | Auto           | No                  |
| `CLAUDE_BINARY_PATH` | Explicit path to the Claude CLI binary                   | Auto-detected  | No                  |
| `FUNNY_DATA_DIR`     | Data directory for DB, secrets, keys                     | `~/.funny`     | No                  |
| `OTLP_ENDPOINT`      | OpenTelemetry collector endpoint                         | —              | No                  |

### `funny-server` (central server)

| Variable                 | Description                                          | Default            | Required          |
|--------------------------|------------------------------------------------------|--------------------|-------------------|
| `PORT`                   | Port to listen on                                    | `3002`             | No                |
| `HOST`                   | Host to bind to                                      | `0.0.0.0`          | No                |
| `RUNNER_AUTH_SECRET`     | Shared secret runners must send to authenticate      | —                  | Yes               |
| `DATABASE_URL`           | PostgreSQL connection URL                            | SQLite             | No                |
| `CORS_ORIGIN`            | Allowed CORS origins (comma-separated)               | Auto               | Yes (remote)      |
| `FUNNY_CENTRAL_DATA_DIR` | Data directory for auth secrets and keys             | `~/.funny-server`  | No                |
| `LOG_LEVEL`              | Log level: `debug` / `info` / `warn` / `error`      | `info`             | No                |

### `packages/client` (separate client build only)

| Variable          | Description                                       | Default              |
|-------------------|---------------------------------------------------|----------------------|
| `VITE_SERVER_URL` | Backend server URL (overrides dev proxy)          | `http://localhost:3001` |
| `VITE_PORT`       | Dev server port                                   | `5173`               |
| `VITE_HOST`       | Dev server host                                   | `localhost`          |

---

## CLI Reference

### `funny`

```
Usage: funny [options]

Options:
  -p, --port <port>    Server port (default: 3001)
  -h, --host <host>    Server host (default: 127.0.0.1)
  --team <url>         Connect to a central team server (activates runner mode)
  --help               Show help message
```

### `funny-server`

```
Usage: funny-server [options]

Options:
  -p, --port <port>    Port to listen on (default: 3002)
  -h, --host <host>    Host to bind to (default: 0.0.0.0)
  --help               Show help message
```

---

## Security Notes

- Change the default `admin` / `admin` password immediately after first startup.
- Generate `RUNNER_AUTH_SECRET` with `openssl rand -hex 32` and keep it secret.
- The `encryption.key` file at `~/.funny/encryption.key` encrypts stored GitHub tokens using AES-256-GCM. **Back it up** — if lost, saved tokens become unrecoverable.
- When exposing the central server to the internet, use a reverse proxy (nginx, Caddy) with TLS.
