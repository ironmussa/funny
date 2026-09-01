# @funny/server

Central coordination server for Funny. Manages users, projects, runner dispatch, browser Socket.IO, and the native gRPC runner data plane. It does **not** execute agents or git operations — those run on [runner instances](../runtime/).

## Architecture

```
Browser  ←→  Central Server (this package)  ←→  Runner (packages/runtime)
               ├─ Auth (Better Auth)              ├─ Claude agents
               ├─ Project membership              ├─ Git operations
               ├─ Runner routing                  └─ Local filesystem
               ├─ Browser Socket.IO
               └─ Runner gRPC endpoint
```

## Deploy to Railway

### 1. Create a Railway project

1. Go to [railway.app](https://railway.app) and create a new project.
2. Add a **PostgreSQL** service from the Railway dashboard (click **+ New** → **Database** → **PostgreSQL**).

### 2. Add the server service

Click **+ New** → **GitHub Repo** and connect this repository, or use **Empty Service** and configure it manually.

#### Build & start commands

| Setting           | Value                                                |
| ----------------- | ---------------------------------------------------- |
| **Build Command** | `bun install && cd packages/server && bun run build` |
| **Start Command** | `cd packages/server && bun run start`                |

> Railway auto-detects Bun if a `bun.lock` or `bun.lockb` file is present. If not, set the builder to **Nixpacks** and add `bun` as a dependency.

#### Root directory

If you want Railway to scope the build to just this package, set the **Root Directory** to the repository root (`/`), not `packages/server`, because the build needs access to the full monorepo (workspace dependencies like `@funny/shared`).

### 3. Set environment variables

In the Railway service settings, add these variables:

| Variable             | Required | Description                                                                                                 |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | Yes      | PostgreSQL connection string. Use Railway's `${{Postgres.DATABASE_URL}}` reference variable to auto-link.   |
| `RUNNER_AUTH_SECRET` | Yes      | Shared secret between the server and runners. Generate one: `openssl rand -hex 32`                          |
| `PORT`               | No       | Railway injects this automatically. Default: `3002`.                                                        |
| `HOST`               | No       | Default: `0.0.0.0` (correct for Railway).                                                                   |
| `CORS_ORIGIN`        | Yes      | Comma-separated origins allowed to connect. Set to your frontend URL (e.g. `https://your-app.railway.app`). |

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
TEAM_SERVER_URL=https://your-app.railway.app
RUNNER_GRPC_ENDPOINT=grpc.your-app.example:443
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

| Variable                                   | Default                 | Description                                        |
| ------------------------------------------ | ----------------------- | -------------------------------------------------- |
| `DATABASE_URL`                             | —                       | PostgreSQL connection string (required)            |
| `RUNNER_AUTH_SECRET`                       | —                       | Shared secret for runner authentication (required) |
| `PORT`                                     | `3002`                  | HTTP server port                                   |
| `HOST`                                     | `0.0.0.0`               | Bind address                                       |
| `CORS_ORIGIN`                              | `http://localhost:5173` | Comma-separated allowed origins                    |
| `FUNNY_CENTRAL_DATA_DIR`                   | `~/.funny-central`      | Directory for auth secrets and encryption keys     |
| `RUNNER_GRPC_ENABLED`                      | `true`                  | Set `false` only when this server offers no runners |
| `RUNNER_GRPC_HOST`                         | `127.0.0.1`             | Private gRPC HTTP/2 bind address                   |
| `RUNNER_GRPC_PORT`                         | `50051`                 | Dedicated gRPC listener port                       |
| `RUNNER_GRPC_MAX_MESSAGE_BYTES`            | `33554432`              | Maximum inbound and outbound gRPC message size     |
| `RUNNER_GRPC_MAX_STREAMS_PER_RUNNER`       | `10`                    | Concurrent stream quota per authenticated runner   |
| `RUNNER_GRPC_AUTH_TIMEOUT_MS`              | `10000`                 | Runner credential lookup timeout                   |
| `RUNNER_GRPC_MAX_FRAME_BYTES`              | `65536`                 | Negotiated frame-size ceiling                      |
| `RUNNER_GRPC_MAX_PENDING_OPERATIONS`       | `32`                    | Negotiated pending-operation ceiling               |
| `RUNNER_GRPC_IDEMPOTENCY_RETENTION_MS`     | `604800000`             | Completed mutation outcome retention (7 days)      |
| `RUNNER_GRPC_MAX_ACTIVE_TUNNELS`           | `4`                     | Negotiated active-tunnel ceiling                   |
| `RUNNER_GRPC_MAX_ACTIVE_TERMINALS`         | `8`                     | Negotiated active-terminal ceiling                 |
| `RUNNER_GRPC_MAX_BUFFERED_BYTES_PER_CLASS` | `1048576`               | Negotiated buffer ceiling per traffic class        |
| `RUNNER_GRPC_HEARTBEAT_INTERVAL_MS`        | `15000`                 | Negotiated runner heartbeat interval               |
| `RUNNER_GRPC_HEARTBEAT_TIMEOUT_MS`         | `45000`                 | Negotiated runner heartbeat expiry                 |
The gRPC listener is the only runner data plane. Its public route must terminate
TLS and preserve HTTP/2 at the deployment
ingress; the dedicated Bun listener accepts only the private ingress hop and
authenticates runner bearer credentials from gRPC metadata.

See [RUNNER_GRPC_RUNBOOK.md](RUNNER_GRPC_RUNBOOK.md) for deployment order,
monitoring, retention, cleanup, and binary rollback procedures.

## API endpoints

| Method | Path              | Description                                    |
| ------ | ----------------- | ---------------------------------------------- |
| `GET`  | `/api/health`     | Health check                                   |
| `GET`  | `/api/auth/mode`  | Returns `{ mode: "multi" }`                    |
| `*`    | `/api/auth/*`     | Better Auth endpoints (login, signup, session) |
| `*`    | `/api/projects/*` | Project CRUD + membership                      |
| `*`    | `/api/runners/*`  | Runner registration + management               |
| `*`    | `/api/profile/*`  | User profile (git identity, GitHub token)      |
| `*`    | `/api/threads/*`  | Thread routing + status                        |
| `*`    | `/api/*`          | Catch-all proxy to assigned runner             |
| `WS`   | `/ws`             | Browser WebSocket                              |
| `gRPC` | dedicated listener | Authenticated native runner transport          |
