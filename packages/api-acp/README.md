# @funny/api-acp

Agent API server that exposes Claude Agent SDK as a run-based protocol. No API keys needed — uses the CLI's own authentication.

## Quick Start

```bash
# From the monorepo root
bun install

# Start the server
cd packages/api-acp
bun run start

# Development (watch mode)
bun run dev
```

The server starts on `http://localhost:4010` by default.

## Usage

```bash
# Create a run (non-streaming)
curl -X POST http://localhost:4010/v1/runs \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "prompt": "Hello!",
    "stream": false
  }'

# Create a run (streaming SSE)
curl -N -X POST http://localhost:4010/v1/runs \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "prompt": "Hello!",
    "stream": true
  }'

# Get run status
curl http://localhost:4010/v1/runs/run_abc123

# Cancel a run
curl -X POST http://localhost:4010/v1/runs/run_abc123/cancel

# List models
curl http://localhost:4010/v1/models
```

## Configuration

### Port

```bash
# CLI argument
bun run start -- --port 8080

# Environment variable
API_ACP_PORT=8080 bun run start
```

### Authentication

By default the server runs without authentication (local mode). Set `API_ACP_KEY` to require a bearer token on all `/v1/*` requests:

```bash
API_ACP_KEY=my-secret-key bun run start
```

Clients must then include the header `Authorization: Bearer my-secret-key`.

## API Endpoints

| Method | Path                  | Description                      |
| ------ | --------------------- | -------------------------------- |
| GET    | `/`                   | Health check                     |
| GET    | `/v1/models`          | List available models            |
| POST   | `/v1/runs`            | Create a run (start agent query) |
| GET    | `/v1/runs/:id`        | Get run status                   |
| POST   | `/v1/runs/:id/cancel` | Cancel an in-flight run          |

### POST `/v1/runs`

**Request body:**

| Field           | Type      | Required | Description                         |
| --------------- | --------- | -------- | ----------------------------------- |
| `model`         | `string`  | Yes      | Model ID or alias                   |
| `prompt`        | `string`  | Yes      | User prompt                         |
| `system_prompt` | `string`  | No       | System prompt                       |
| `tools`         | `array`   | No       | Tool definitions (function calling) |
| `max_turns`     | `number`  | No       | Max agent turns                     |
| `stream`        | `boolean` | No       | Enable SSE streaming                |

**Non-streaming response:**

```json
{
  "id": "run_abc123",
  "status": "completed",
  "model": "claude-sonnet-4-5-20250929",
  "created_at": 1740000000,
  "completed_at": 1740000005,
  "usage": { "input_tokens": 100, "output_tokens": 50 },
  "result": {
    "text": "Hello! How can I help you?",
    "tool_calls": []
  }
}
```

**Streaming SSE events:**

```
event: run.created
data: {"id":"run_abc123","status":"created","model":"claude-sonnet-4-5-20250929","created_at":1740000000}

event: run.status
data: {"id":"run_abc123","status":"running"}

event: text.delta
data: {"delta":"Hello! "}

event: text.delta
data: {"delta":"How can I help you?"}

event: run.completed
data: {"id":"run_abc123","status":"completed",...}

event: done
data: "[DONE]"
```

### Run States

```
created → running → completed
                  → cancelled
                  → failed
```

## Supported Models

### Claude (via Anthropic)

| Alias               | Resolves to                  |
| ------------------- | ---------------------------- |
| `claude-sonnet`     | `claude-sonnet-4-5-20250929` |
| `claude-sonnet-4.5` | `claude-sonnet-4-5-20250929` |
| `claude-sonnet-4.6` | `claude-sonnet-4-6`          |
| `claude-opus`       | `claude-opus-4-6`            |
| `claude-opus-4.6`   | `claude-opus-4-6`            |
| `claude-haiku`      | `claude-haiku-4-5-20251001`  |
| `claude-haiku-4.5`  | `claude-haiku-4-5-20251001`  |

Full model IDs (e.g. `claude-sonnet-4-5-20250929`) are also accepted directly.

### Other Providers

Model IDs with recognized prefixes are routed to their respective providers:

- **OpenAI**: `gpt-*`, `o1*`, `o3*`, `o4*`
- **Gemini**: `gemini-*`
- **Ollama**: `ollama/*` (e.g. `ollama/llama3:70b`)

## Architecture

```
src/
├── index.ts                 # Server entry point (Hono + middleware)
├── routes/
│   ├── runs.ts              # POST/GET /v1/runs (create, status, cancel)
│   └── models.ts            # GET /v1/models
└── utils/
    ├── run-registry.ts      # In-flight run tracking and lifecycle
    └── model-resolver.ts    # Model ID mapping and resolution
```

The server uses the Claude Agent SDK's `query()` function directly to process requests. Each run tracks its lifecycle (created → running → completed/cancelled/failed) with proper cancellation support via AbortController.
