# Deploying funny to Railway (agent guide)

How an agent connects to Railway and deploys the production funny stack. Written
from a real deploy session — follow it verbatim; the gotchas below are the ones
that actually bit us.

## TL;DR

```bash
cd <repo root>
set -a; . ./.env.railway-token.local; set +a   # load RAILWAY_TOKEN — SOURCE it, do not cat it
railway status                                  # confirms you're pointed at the funny project
railway up --service funny-runner --detach      # deploy the runner  (spawns the Claude Code CLI)
railway up --service funny-server --detach      # deploy the server  (model registry + UI + API)
```

Then verify (see [Verify a deploy](#verify-a-deploy)).

## The project

| Field | Value |
|---|---|
| Project | `funny` |
| Project ID | `373f9d06-a436-4292-b20c-9f0b2096a588` |
| Workspace | `Argenis Leon's Projects` |
| Environment | `production` (`f9b2196c-7ce6-4045-976e-fdf8763b911f`) |

Services in the environment:

| Service | Role | Public URL |
|---|---|---|
| `funny-server` | Auth, DB owner, serves the client UI, proxies to runners. Uses `packages/shared` model registry to validate/offer models. | https://funny-server-production.up.railway.app |
| `funny-runner` | Executes agent work — **spawns the Claude Code CLI** bundled with `@anthropic-ai/claude-agent-sdk`. Connects out to the server over a gRPC tunnel. | https://funny-runner-production.up.railway.app |
| `Postgres` | Database | — |

## Credentials — the token gotcha

The Railway **project token** lives in `.env.railway-token.local` (git-ignored;
never commit it, never paste its value into a doc/PR/log). The file is a
shell-sourceable line:

```bash
export RAILWAY_TOKEN='<token>'
```

- **SOURCE it, never `cat` it.** `RAILWAY_TOKEN="$(cat .env.railway-token.local)"`
  captures the whole `export RAILWAY_TOKEN='...'` line (incl. quotes) as the value
  → every call returns `Invalid RAILWAY_TOKEN`. Correct:
  ```bash
  set -a; . ./.env.railway-token.local; set +a
  ```
- **`railway whoami` fails with a project token** (`Unauthorized`). That is
  expected — project tokens are not account tokens. Use `railway status` to
  confirm access instead; it prints the project, environment, and services.
- The MCP Railway integration in this environment may be authenticated as a
  **different account** that does NOT have the funny project. Don't rely on the
  `mcp__railway__*` tools for funny — use the CLI with the project token.
- The bash sandbox blocks outbound network. Run every `railway`/`curl` command
  with the sandbox disabled (`dangerouslyDisableSandbox: true`).

## Deploying

`railway up` uploads the **current working tree** (respecting `.gitignore`) — it
does NOT go through git, so uncommitted changes are included. Commit first if you
want the deployed state to match a commit.

```bash
set -a; . ./.env.railway-token.local; set +a
railway up --service funny-runner --detach
railway up --service funny-server --detach
```

- `--service` is **required** — the project has multiple services and no linked
  default (`Linked service: None`).
- `--detach` returns after upload; the build runs async on Railway (Railpack →
  `bun run build`). Without it the command streams build logs and blocks.
- **Deploy both services** when your change touches models/agents:
  - server → the model registry (`packages/shared/src/models.ts`), so the UI
    offers the model and the API doesn't reject it.
  - runner → the bundled Claude Code CLI. A new Claude model can require a newer
    CLI (e.g. Opus 5.5 needs Claude Code ≥ 2.1.280, i.e.
    `@anthropic-ai/claude-agent-sdk ≥ 0.3.280`). **Only a runner redeploy/restart
    picks up a new CLI** — bumping `package.json` alone does nothing until the
    runner process restarts on the freshly-built image.

## Verify a deploy

Watch build status until both reach `SUCCESS`:

```bash
set -a; . ./.env.railway-token.local; set +a
railway status --json | python3 - <<'PY'
import sys, json
d = json.load(sys.stdin)
for e in d.get("environments", {}).get("edges", []):
    for si in e["node"].get("serviceInstances", {}).get("edges", []):
        n = si["node"]
        name = n.get("serviceName") or n.get("serviceId", "?")
        for dep in n.get("activeDeployments", []) or []:
            print(f'{name:16} status={dep.get("status")} id={(dep.get("id") or "")[:8]}')
PY
```

Statuses go `BUILDING → DEPLOYING → SUCCESS` (or `FAILED`/`CRASHED`). Then:

```bash
curl -s -o /dev/null -w "server /api/health -> %{http_code}\n" \
  https://funny-server-production.up.railway.app/api/health   # expect 200

railway logs --service funny-runner --lines 40                # expect the runner boot lines
```

Healthy runner logs look like:

```
Connecting to server at https://funny-server-production.up.railway.app
Runner gRPC session activated  (protocol runner.v2.0)
Runner listening on http://0.0.0.0:3003  version=0.1.x
Provider claude: available
```

**A `502` on the runner's public root (`/`) is normal** — the runner doesn't
serve its root publicly; the server reaches it over the internal gRPC tunnel
(port 3003). Judge the runner by `railway status` + its logs, not by `curl /`.

## Notes

- Config-as-Code (`railway.json`) is deprecated by Railway (works until
  2026-12-01). Migration target is `.railway/railway.ts`
  (`railway config migrate`). Not urgent.
- Start commands (set per service in Railway, not in `railway.json`):
  `start:railway` = `cd packages/server && bun run start`. The runner service
  runs the runtime entry from the same build.
