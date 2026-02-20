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

### 1. Start the observability stack

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

### 2. Start the app

```bash
bun run dev
```

The middleware is already wired in `packages/server/src/index.ts`. Telemetry flows automatically.

### 3. Query your data

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

### 4. Stop the stack

```bash
cd packages/observability
docker compose down
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

**Frontend logs:** Use the `useLogger` hook in React components:

```tsx
import { useLogger } from '@/hooks/use-logger';

function MyComponent() {
  const log = useLogger('MyComponent');

  const handleClick = () => {
    log.info('Button clicked', { 'button.id': 'submit' });
  };

  // Logs are batched and sent every 5s to POST /api/logs → OTLP → Victoria Logs
}
```

The hook also captures `window.onerror` and `unhandledrejection` events automatically.

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
    ├── index.ts          # Public API: observability(), observabilityShutdown(), emitLog()
    ├── config.ts         # Env var config + OTel Resource
    ├── exporter.ts       # OTLP HTTP exporters (metrics + traces + logs)
    ├── tracer.ts         # TracerProvider setup
    ├── metrics.ts        # MeterProvider + HTTP instruments
    ├── logger.ts         # LoggerProvider + emitLog() for OTLP log export
    └── middleware.ts      # Hono middleware (spans + metrics per request)
```

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

## Data Retention

Victoria services are configured with 30 days retention by default. Data is stored in Docker volumes (`vm-data`, `vl-data`, `vt-data`). To reset:

```bash
cd packages/observability
docker compose down -v   # -v removes volumes
```
