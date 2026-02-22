# @funny/api-acp

OpenAI-compatible API proxy that translates OpenAI API requests to Claude models using the Claude Agent SDK. No API keys needed — uses the CLI's own authentication.

Use it as a drop-in replacement for OpenAI's API in any tool or library that supports a custom base URL.

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

Point any OpenAI-compatible client to `http://localhost:4010/v1`:

```bash
# Non-streaming
curl http://localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# List models
curl http://localhost:4010/v1/models
```

### With the OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4010/v1", api_key="unused")

response = client.chat.completions.create(
    model="claude-sonnet",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### With the OpenAI Node SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:4010/v1", apiKey: "unused" });

const response = await client.chat.completions.create({
  model: "claude-sonnet",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
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

| Method | Path                      | Description                          |
| ------ | ------------------------- | ------------------------------------ |
| GET    | `/`                       | Health check                         |
| GET    | `/v1/models`              | List available models (OpenAI format)|
| POST   | `/v1/chat/completions`    | Chat completions (streaming & non-streaming) |

### POST `/v1/chat/completions`

**Request body:**

| Field         | Type       | Required | Description                     |
| ------------- | ---------- | -------- | ------------------------------- |
| `model`       | `string`   | Yes      | Model ID or alias               |
| `messages`    | `array`    | Yes      | Array of `{role, content}` objects |
| `stream`      | `boolean`  | No       | Enable SSE streaming            |
| `temperature` | `number`   | No       | Sampling temperature            |
| `max_tokens`  | `number`   | No       | Max tokens to generate          |
| `top_p`       | `number`   | No       | Nucleus sampling parameter      |
| `stop`        | `string \| string[]` | No | Stop sequences           |

## Supported Models

### Claude (via Anthropic)

| Alias              | Resolves to                    |
| ------------------ | ------------------------------ |
| `claude-sonnet`    | `claude-sonnet-4-5-20250929`   |
| `claude-sonnet-4.5`| `claude-sonnet-4-5-20250929`   |
| `claude-sonnet-4.6`| `claude-sonnet-4-6`            |
| `claude-opus`      | `claude-opus-4-6`              |
| `claude-opus-4.6`  | `claude-opus-4-6`              |
| `claude-haiku`     | `claude-haiku-4-5-20251001`    |
| `claude-haiku-4.5` | `claude-haiku-4-5-20251001`    |

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
│   ├── chat.ts              # POST /v1/chat/completions
│   └── models.ts            # GET /v1/models
└── utils/
    ├── format.ts            # OpenAI response format conversion
    └── model-resolver.ts    # Model ID mapping and resolution
```

The server uses the Claude Agent SDK's `query()` function directly to process requests. Messages are converted from OpenAI's multi-message format into a single prompt, sent to Claude, and the response is formatted back into OpenAI's response schema — including token usage statistics.
