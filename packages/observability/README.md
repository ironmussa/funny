# @funny/observability

Observability package for funny. Provides HTTP-layer metrics, traces, and logs via OpenTelemetry, with a local observability stack powered by Vector + VictoriaMetrics.

## Architecture

```
┌─────────────┐
│  Browser     │──POST /api/logs──┐
│  (React)     │                  │
│  useLogger() │                  │
└─────────────┘                  │
                                  v
┌─────────────┐         ┌──────────────────┐
│  Hono server │──OTLP──>│     Vector       │
│  (Winston +  │         │  localhost:4318   │
│   OTel SDK)  │         └──────┬───────────┘
└─────────────┘                │ fan out
                               │
                ┌──────────────┼──────────────┐
                v              v              v
         Victoria Metrics  Victoria Logs  Victoria Traces
         localhost:8428    localhost:9428  localhost:10428
         (PromQL)          (LogQL)        (TraceQL)
```

The app sends all telemetry (metrics, traces, logs) to a single OTLP endpoint (Vector). Vector fans out to the 3 Victoria backends. Frontend logs are proxied through the server via `POST /api/logs`.

## Quick Start

### Option A: Docker Compose (recommended)

```bash
cd packages/observability
docker compose up -d
```

This starts 4 services:

| Service | Port | Purpose |
|---------|------|---------|
| Vector | 4318 | OTLP HTTP receiver, fans out to Victoria |
| Victoria Metrics | 8428 | Time series DB for metrics (PromQL) |
| Victoria Logs | 9428 | Log storage (LogQL) |
| Victoria Traces | 10428 | Distributed tracing (TraceQL) |

To stop: `docker compose down` (add `-v` to also delete stored data).

### Option B: Without Docker (native binaries)

Download and run each service as a standalone binary. No Docker, no daemon, no overhead.

**1. Vector** (OTLP receiver + fan-out)

```bash
# macOS
brew install vector

# Linux (x86_64)
curl -sSL https://packages.timber.io/vector/latest/vector-x86_64-unknown-linux-gnu.tar.gz | tar xz
sudo mv vector-x86_64-unknown-linux-gnu/bin/vector /usr/local/bin/

# Windows (scoop)
scoop install vector

# Run with our config
vector --config packages/observability/vector.toml
```

**2. Victoria Metrics** (metrics storage)

```bash
# Download from https://github.com/VictoriaMetrics/VictoriaMetrics/releases
# macOS example:
curl -L https://github.com/VictoriaMetrics/VictoriaMetrics/releases/latest/download/victoria-metrics-darwin-amd64.tar.gz | tar xz

# Run
./victoria-metrics-prod --retentionPeriod=30d --httpListenAddr=:8428
```

**3. Victoria Logs** (log storage)

```bash
# Download from https://github.com/VictoriaMetrics/VictoriaMetrics/releases (vlogs)
curl -L https://github.com/VictoriaMetrics/VictoriaMetrics/releases/latest/download/victoria-logs-darwin-amd64.tar.gz | tar xz

# Run
./victoria-logs-prod --retentionPeriod=30d --httpListenAddr=:9428
```

**4. Victoria Traces** (trace storage)

```bash
# Download from https://github.com/VictoriaMetrics/VictoriaMetrics/releases (vtraces)
curl -L https://github.com/VictoriaMetrics/VictoriaMetrics/releases/latest/download/victoria-traces-darwin-amd64.tar.gz | tar xz

# Run
./victoria-traces-prod --httpListenAddr=:10428
```

When running without Docker, update `vector.toml` sink endpoints to use `localhost` instead of the Docker service names:

```toml
# Change these:
#   http://victoria-metrics:8428  →  http://localhost:8428
#   http://victoria-logs:9428     →  http://localhost:9428
#   http://victoria-traces:10428  →  http://localhost:10428
```

### Start the app

```bash
bun run dev
```

The middleware is already wired in `packages/server/src/index.ts`. Telemetry flows automatically.

### Query your data

**Metrics** (Victoria Metrics UI):
```
http://localhost:8428/vmui
```

**Logs** (Victoria Logs UI):
```
http://localhost:9428/select/vmui
```

**Traces** — query via API:
```bash
curl http://localhost:10428/select/0/vmui
```

## What Gets Captured

The middleware auto-instruments every HTTP request with:

### Metrics
| Metric | Type | Description |
|--------|------|-------------|
| `http.server.request.duration` | Histogram | Request duration in ms |
| `http.server.request.total` | Counter | Total request count |
| `http.server.active_requests` | UpDownCounter | In-flight requests |

Labels: `http.method`, `http.route`, `http.status_code`

### Traces
One span per HTTP request with:
- `http.method`, `http.route`, `http.status_code`, `http.url`
- Duration automatically recorded
- Error status set on 5xx responses
- W3C trace context propagation (`traceparent` header)

### Logs

**Backend logs:** Winston logger automatically forwards all `log.info()`, `log.error()`, etc. calls to Victoria Logs via OTLP. No code changes needed — the transport is pre-wired.

**Browser logs (any framework):** Use `BrowserLogger` — a vanilla JS class with zero framework dependencies:

```typescript
import { BrowserLogger } from '@funny/observability/browser';

// Works in React, Vue, Svelte, vanilla JS — anything with a browser
const logger = new BrowserLogger({
  endpoint: '/api/logs',           // your server's log ingest endpoint
  authToken: 'my-token',           // optional: Authorization header
  defaultAttributes: { app: 'my-app' },
});

logger.info('Page loaded');
logger.error('API failed', { 'api.url': '/users' });
logger.warn('Slow render', { 'duration.ms': '1200' });

// Namespaced child loggers
const navLog = logger.child({ 'component': 'navbar' });
navLog.info('Menu opened');
```

Features:
- Batches logs (flushes every 5s or every 25 entries)
- Auto-captures `window.onerror` and `unhandledrejection`
- Flushes on `beforeunload` (uses `keepalive: true`)
- `.child()` for namespaced loggers
- `.destroy()` to clean up timers

**React hook (optional):** If using React, a thin wrapper is available:

```tsx
import { useLogger } from '@/hooks/use-logger';

function MyComponent() {
  const log = useLogger('MyComponent');
  log.info('Rendered');
}
```

## Configuration

Via environment variables:

| Env Var | Default | Description |
|---------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP endpoint (Vector) |
| `OTEL_SERVICE_NAME` | `funny-server` | Service name in telemetry |
| `OTEL_ENABLED` | `true` | Set to `false` to disable telemetry |
| `OTEL_EXPORT_INTERVAL_MS` | `10000` | Metrics export interval (ms) |

Or pass overrides programmatically:

```typescript
app.use('*', observability({
  endpoint: 'http://my-collector:4318',
  serviceName: 'my-service',
}));
```

## Integration

Already wired in `packages/server/src/index.ts`:

```typescript
import { observability, observabilityShutdown } from '@funny/observability';

// Middleware — after CORS/security, before routes
app.use('*', observability());

// Shutdown — flush pending telemetry on exit
await observabilityShutdown();
```

## Package Structure

```
packages/observability/
├── docker-compose.yml    # Vector + Victoria stack
├── vector.toml           # Vector config (OTLP source → Victoria sinks)
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # Server API: observability(), observabilityShutdown(), emitLog()
    ├── browser.ts        # Browser API: BrowserLogger (vanilla JS, no framework deps)
    ├── config.ts         # Env var config + OTel Resource
    ├── exporter.ts       # OTLP HTTP exporters (metrics + traces + logs)
    ├── tracer.ts         # TracerProvider setup
    ├── metrics.ts        # MeterProvider + HTTP instruments
    ├── logger.ts         # LoggerProvider + emitLog() for OTLP log export
    └── middleware.ts      # Hono middleware (spans + metrics per request)
```

### Exports

| Import | Environment | Purpose |
|--------|-------------|---------|
| `@funny/observability` | Node/Bun | Server SDK: middleware, traces, metrics, emitLog |
| `@funny/observability/browser` | Browser | BrowserLogger: vanilla JS client for any framework |
| `@funny/observability/logger` | Node/Bun | Direct access to LoggerProvider + emitLog |

## Scripts

```bash
bun run stack:up     # docker compose up -d
bun run stack:down   # docker compose down
bun run stack:logs   # docker compose logs -f
```

## Example PromQL Queries

```promql
# Request rate per route (last 5 min)
rate(http_server_request_total[5m])

# P95 latency by route
histogram_quantile(0.95, rate(http_server_request_duration_bucket[5m]))

# Error rate (5xx responses)
rate(http_server_request_total{http_status_code=~"5.."}[5m])

# Active in-flight requests
http_server_active_requests
```

## Framework Examples

`BrowserLogger` is vanilla JS — no framework required. Below are examples for common frameworks.

### Vanilla JS

```html
<script type="module">
import { BrowserLogger } from '@funny/observability/browser';

const log = new BrowserLogger({ endpoint: 'https://myserver.com/api/logs' });

document.getElementById('btn').addEventListener('click', () => {
  log.info('Button clicked', { 'button.id': 'btn' });
});

// Errors are captured automatically (window.onerror, unhandledrejection)
</script>
```

### React

```tsx
// hooks/use-logger.ts
import { useMemo } from 'react';
import { BrowserLogger } from '@funny/observability/browser';

const logger = new BrowserLogger({ endpoint: '/api/logs' });

export function useLogger(namespace?: string) {
  return useMemo(() => {
    return namespace ? logger.child({ 'log.namespace': namespace }) : logger;
  }, [namespace]);
}

// components/Dashboard.tsx
import { useLogger } from '../hooks/use-logger';

export function Dashboard() {
  const log = useLogger('Dashboard');

  const handleRefresh = () => {
    log.info('User refreshed data');
    fetchData().catch((err) => {
      log.error('Failed to fetch data', { 'error': err.message });
    });
  };

  return <button onClick={handleRefresh}>Refresh</button>;
}
```

### Vue 3

```typescript
// composables/useLogger.ts
import { BrowserLogger } from '@funny/observability/browser';

const logger = new BrowserLogger({ endpoint: '/api/logs' });

export function useLogger(namespace?: string) {
  return namespace ? logger.child({ 'log.namespace': namespace }) : logger;
}
```

```vue
<!-- components/Dashboard.vue -->
<script setup lang="ts">
import { useLogger } from '../composables/useLogger';

const log = useLogger('Dashboard');

function handleRefresh() {
  log.info('User refreshed data');
  fetchData().catch((err) => {
    log.error('Failed to fetch data', { error: err.message });
  });
}
</script>

<template>
  <button @click="handleRefresh">Refresh</button>
</template>
```

### Svelte

```typescript
// lib/logger.ts
import { BrowserLogger } from '@funny/observability/browser';

export const logger = new BrowserLogger({ endpoint: '/api/logs' });

export function createLogger(namespace: string) {
  return logger.child({ 'log.namespace': namespace });
}
```

```svelte
<!-- routes/Dashboard.svelte -->
<script lang="ts">
import { createLogger } from '$lib/logger';

const log = createLogger('Dashboard');

function handleRefresh() {
  log.info('User refreshed data');
}
</script>

<button on:click={handleRefresh}>Refresh</button>
```

### Node.js / Bun (server-side)

For server-side logging without the Hono middleware, use `emitLog` directly:

```typescript
import { emitLog } from '@funny/observability';

// In any server-side code
emitLog('info', 'Job started', { 'job.id': '123', 'job.type': 'sync' });
emitLog('error', 'Job failed', { 'job.id': '123', 'error': 'timeout' });
```

## Data Retention

Victoria services are configured with 30 days retention by default. Data is stored in Docker volumes (`vm-data`, `vl-data`, `vt-data`). To reset:

```bash
cd packages/observability
docker compose down -v   # -v removes volumes
```
