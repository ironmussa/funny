# Plan: `@funny/observability` Package

## Goal

Create a new `packages/observability` package that provides:

1. **App instrumentation** — Hono middleware that auto-captures HTTP metrics and traces via OpenTelemetry
2. **Local observability stack** — Docker Compose with Vector + Victoria Metrics/Logs/Traces

## Architecture

```
App (Hono server)
  |
  |-- OTLP HTTP (metrics + traces + logs)
  v
Vector (localhost:4318)
  |
  |-- Fan out (local)
  |
  ├──> Victoria Logs    (localhost:9428)  — LogQL API
  ├──> Victoria Metrics (localhost:8428)  — PromQL API
  └──> Victoria Traces  (localhost:9411)  — TraceQL API
```

## Package Structure

```
packages/observability/
├── package.json              # @funny/observability
├── tsconfig.json             # extends ../../tsconfig.base.json
├── docker-compose.yml        # Vector + Victoria Logs/Metrics/Traces
├── vector.toml               # Vector config: OTLP source → Victoria sinks
└── src/
    ├── index.ts              # Public API: middleware + init + shutdown
    ├── config.ts             # Env var config (OTLP endpoint, service name)
    ├── middleware.ts          # Hono middleware: spans + metrics per request
    ├── metrics.ts            # MeterProvider + HTTP instruments (histogram, counters)
    ├── tracer.ts             # TracerProvider + span creation
    └── exporter.ts           # OTLP HTTP exporters (metrics + traces)
```

## Dependencies

- **@opentelemetry/api** — Standard OTel API for spans, context, metrics
- **@opentelemetry/sdk-trace-node** — Trace SDK (span processor, tracer provider)
- **@opentelemetry/sdk-metrics** — Metrics SDK (meter provider, readers)
- **@opentelemetry/exporter-trace-otlp-http** — OTLP/HTTP trace exporter
- **@opentelemetry/exporter-metrics-otlp-http** — OTLP/HTTP metrics exporter
- **@opentelemetry/resources** — Resource attributes (service.name, etc.)
- **@opentelemetry/semantic-conventions** — Standard attribute names
- **hono** — Peer dependency (middleware typing)

## What the Middleware Captures

For every HTTP request:

### Metrics (→ Vector → Victoria Metrics)

- `http.server.request.duration` — Histogram of request duration in ms
- `http.server.request.total` — Counter of total requests
- `http.server.active_requests` — UpDownCounter of in-flight requests

Labels: `http.method`, `http.route`, `http.status_code`

### Traces (→ Vector → Victoria Traces)

- One span per HTTP request with:
  - `http.method`, `http.route`, `http.status_code`, `http.url`
  - Duration automatically recorded
  - Error status set on 5xx responses
  - W3C trace context propagation (traceparent header)

## Docker Compose Services

```yaml
services:
  vector: # OTLP receiver + fan-out
    image: timberio/vector:latest-alpine
    ports: ['4318:4318']

  victoria-metrics: # Time series DB (PromQL)
    image: victoriametrics/victoria-metrics:latest
    ports: ['8428:8428']

  victoria-logs: # Log storage (LogQL)
    image: victoriametrics/victoria-logs:latest
    ports: ['9428:9428']

  victoria-traces: # Distributed tracing (TraceQL)
    image: victoriametrics/victoria-traces:latest
    ports: ['9411:9411']
```

## Vector Config (vector.toml)

- **Source:** OpenTelemetry receiver on `:4318` (OTLP HTTP)
- **Sink 1:** Victoria Metrics via Prometheus remote write
- **Sink 2:** Victoria Logs via JSON HTTP
- **Sink 3:** Victoria Traces via OTLP/Zipkin

## Configuration

Via environment variables with sensible defaults:

| Env Var                       | Default                 | Description                 |
| ----------------------------- | ----------------------- | --------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP endpoint (Vector) |
| `OTEL_SERVICE_NAME`           | `funny-server`          | Service name in telemetry   |
| `OTEL_ENABLED`                | `true`                  | Kill switch for telemetry   |
| `OTEL_EXPORT_INTERVAL_MS`     | `10000`                 | Metrics export interval     |

## Integration with Server

In `packages/server/src/index.ts`:

```typescript
import { observability } from '@funny/observability';

// Add after existing middleware, before routes:
app.use('*', observability());
```

Server's `package.json` gets `"@funny/observability": "*"`.
Server's `shutdown()` calls `observabilityShutdown()` to flush pending telemetry.

## Implementation Steps

1. **Create `packages/observability/`** — `package.json`, `tsconfig.json`
2. **Create `docker-compose.yml`** — Vector + 3 Victoria services
3. **Create `vector.toml`** — OTLP source, 3 sinks (metrics, logs, traces)
4. **Implement `config.ts`** — read env vars, build OTel resource
5. **Implement `exporter.ts`** — OTLP HTTP exporters for metrics + traces
6. **Implement `tracer.ts`** — TracerProvider with OTLP exporter
7. **Implement `metrics.ts`** — MeterProvider with HTTP instruments
8. **Implement `middleware.ts`** — Hono middleware (spans + metrics per request)
9. **Implement `index.ts`** — public API, init, shutdown, re-exports
10. **Wire into server** — add dependency + middleware + shutdown call
11. **Run `bun install`** — link workspace package
12. **Verify** — `bun run build` to confirm compilation

## Usage

```bash
# 1. Start the observability stack
cd packages/observability && docker compose up -d

# 2. Start the app (telemetry flows automatically via middleware)
bun run dev

# 3. Query metrics
curl 'http://localhost:8428/api/v1/query?query=http_server_request_duration_bucket'

# 4. View traces
curl 'http://localhost:9411/api/v2/traces'

# 5. Stop the stack
cd packages/observability && docker compose down
```
