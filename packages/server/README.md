# @funny/server

Central coordination server for Funny. Manages users, projects, runner dispatch, and WebSocket relay. It does **not** execute agents or git operations — those run on [runner instances](../runtime/).

## Architecture

```
Browser  ←→  Central Server (this package)  ←→  Runner (packages/runtime)
               ├─ Auth (Better Auth)              ├─ Claude agents
               ├─ Project membership              ├─ Git operations
               ├─ Runner routing                  └─ Local filesystem
               └─ WebSocket relay
```

## Deploy to Railway

### 1. Create a Railway project

1. Go to [railway.app](https://railway.app) and create a new project.
2. Add a **PostgreSQL** service from the Railway dashboard (click **+ New** → **Database** → **PostgreSQL**).

### 2. Add the server service

Click **+ New** → **GitHub Repo** and connect this repository, or use **Empty Service** and configure it manually.

#### Build & start commands

| Setting | Value |
|---------|-------|
| **Build Command** | `bun install && cd packages/server && bun run build` |
| **Start Command** | `cd packages/server && bun run start` |

> Railway auto-detects Bun if a `bun.lock` or `bun.lockb` file is present. If not, set the builder to **Nixpacks** and add `bun` as a dependency.

#### Root directory

If you want Railway to scope the build to just this package, set the **Root Directory** to the repository root (`/`), not `packages/server`, because the build needs access to the full monorepo (workspace dependencies like `@funny/shared`).

### 3. Set environment variables

In the Railway service settings, add these variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string. Use Railway's `${{Postgres.DATABASE_URL}}` reference variable to auto-link. |
| `RUNNER_AUTH_SECRET` | Yes | Shared secret between the server and runners. Generate one: `openssl rand -hex 32` |
| `PORT` | No | Railway injects this automatically. Default: `3002`. |
| `HOST` | No | Default: `0.0.0.0` (correct for Railway). |
| `CORS_ORIGIN` | Yes | Comma-separated origins allowed to connect. Set to your frontend URL (e.g. `https://your-app.railway.app`). |
| `DEFAULT_RUNNER_URL` | No | Fallback runner URL when no runner is assigned to a project. |

Example:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
RUNNER_AUTH_SECRET=your-generated-secret-here
CORS_ORIGIN=https://your-app.railway.app
```

### 4. Deploy

Push to your connected branch or click **Deploy** in the Railway dashboard. Railway will:

1. Install dependencies with `bun install`
2. Build the server bundle (`dist/index.js`)
3. Start the server with `bun run dist/index.js`
4. Auto-run database migrations on startup

### 5. Verify

Once deployed, check the health endpoint:

```bash
curl https://your-app.railway.app/api/health
```

You should get:

```json
{ "status": "ok", "service": "funny-server", ... }
```

## Default admin account

On first startup the server creates a default admin:

- **Username:** `admin`
- **Password:** `admin`

Change this immediately after your first login.

## Connect a runner

Each runner (machine running `packages/runtime`) needs to connect to the central server. On the runner machine, set:

```env
CENTRAL_SERVER_URL=https://your-app.railway.app
RUNNER_AUTH_SECRET=same-secret-as-server
```

Then start the runtime normally (`bun run dev` or `bun start` in `packages/runtime`).

## Local development

```bash
# Install all workspace dependencies from the repo root
bun install

# Copy and edit the env file
cp packages/server/.env.example packages/server/.env

# You need a PostgreSQL instance running locally
# Edit .env with your DATABASE_URL and add RUNNER_AUTH_SECRET

# Start the server in watch mode
cd packages/server && bun run dev
```

## Environment variables reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `RUNNER_AUTH_SECRET` | — | Shared secret for runner authentication (required) |
| `PORT` | `3002` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `DEFAULT_RUNNER_URL` | — | Fallback runner URL |
| `FUNNY_CENTRAL_DATA_DIR` | `~/.funny-central` | Directory for auth secrets and encryption keys |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/auth/mode` | Returns `{ mode: "multi" }` |
| `*` | `/api/auth/*` | Better Auth endpoints (login, signup, session) |
| `*` | `/api/projects/*` | Project CRUD + membership |
| `*` | `/api/runners/*` | Runner registration + management |
| `*` | `/api/profile/*` | User profile (git identity, GitHub token) |
| `*` | `/api/threads/*` | Thread routing + status |
| `*` | `/api/*` | Catch-all proxy to assigned runner |
| `WS` | `/ws` | Browser WebSocket |
| `WS` | `/ws/runner` | Runner WebSocket |
