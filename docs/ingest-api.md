# Ingest API — External Agent Integration

The Ingest API allows external agents to create threads and stream their activity into Funny's UI in real time. Any process that can make HTTP requests can use this API to display its output as a native Funny thread.

## Setup

Set the `INGEST_WEBHOOK_SECRET` environment variable before starting the server:

```bash
export INGEST_WEBHOOK_SECRET=my-secret-token
```

All requests must include this secret in the `X-Webhook-Secret` header.

## Endpoint

```
POST /api/ingest/webhook
Content-Type: application/json
X-Webhook-Secret: <your-secret>
```

## Event Structure

```typescript
{
  event_type: string;       // Determines the action (see Event Types below)
  request_id: string;       // Correlator for new threads (used to link events together)
  thread_id?: string;       // Direct thread ID — for sending to existing threads
  timestamp: string;        // ISO 8601 timestamp
  data: object;             // Event-specific payload
  metadata?: object;        // Optional metadata (projectId, userId, prompt)
}
```

### Identifying Threads

There are two ways to target a thread:

| Field | Use case |
|---|---|
| `request_id` | For new threads created via `*.accepted`. All subsequent events for the same thread use the same `request_id`. |
| `thread_id` | For sending events to any existing thread (created in the UI or via API). Takes priority over `request_id`. |

You can mix both: create a thread with `request_id`, then later reference it by `thread_id` if you know it.

## Event Types

The `event_type` field uses a suffix-based routing system. The suffix (last segment after `.`) determines the action:

| Suffix | Action | Required fields |
|---|---|---|
| `*.accepted` | Create a new thread (or link to existing via `thread_id`) | `data.title`, `metadata.projectId` |
| `*.started` | Mark thread as running | — |
| `*.cli_message` | Send a Claude CLI message (assistant text, tool calls, results) | `data.cli_message` |
| `*.message` | Send a simple text message | `data.text` or `data.content` |
| `*.completed` | Mark thread as completed | — |
| `*.failed` | Mark thread as failed | — |
| `*.stopped` | Mark thread as stopped | — |

The prefix can be anything (e.g. `agent.accepted`, `pipeline.cli_message`, `mybot.completed`).

---

## Quick Start: Simple Messages

The fastest way to get started — send plain text messages without CLI format.

### 1. Create a thread

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.accepted",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "title": "Code Analysis Agent",
      "prompt": "Analyzing src/ for security issues..."
    },
    "metadata": {
      "projectId": "YOUR_PROJECT_ID"
    }
  }'
```

### 2. Send messages

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.message",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "text": "Found 3 potential SQL injection vulnerabilities in db/queries.ts",
      "role": "assistant"
    }
  }'
```

### 3. Mark as completed

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.completed",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "result": "Analysis complete. 3 issues found.",
      "cost_usd": 0.05,
      "duration_ms": 12000
    }
  }'
```

---

## CLI Message Format (Full Fidelity)

For agents that produce Claude CLI-compatible output (NDJSON stream-json), use `*.cli_message` events. This gives full fidelity: text streaming, tool call cards, tool results, and proper message threading — exactly like a native Funny thread.

### Assistant text message

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "cli_message": {
        "type": "assistant",
        "message": {
          "id": "msg_001",
          "content": [
            { "type": "text", "text": "I found a bug on line 42 of server.ts..." }
          ]
        }
      }
    }
  }'
```

### Tool call (e.g. Read file)

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "cli_message": {
        "type": "assistant",
        "message": {
          "id": "msg_002",
          "content": [
            {
              "type": "tool_use",
              "id": "tool_001",
              "name": "Read",
              "input": { "file_path": "/src/server.ts", "limit": 50 }
            }
          ]
        }
      }
    }
  }'
```

### Tool result

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "cli_message": {
        "type": "user",
        "message": {
          "content": [
            {
              "type": "tool_result",
              "tool_use_id": "tool_001",
              "content": "const app = express();\n// ... file contents ..."
            }
          ]
        }
      }
    }
  }'
```

### System init (optional — sets status to running)

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "cli_message": {
        "type": "system",
        "subtype": "init",
        "session_id": "session_abc123",
        "tools": ["Read", "Write", "Bash", "Grep"],
        "cwd": "/home/user/project",
        "model": "claude-sonnet-4-5-20250929"
      }
    }
  }'
```

### Result (finalizes the thread)

```bash
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "request_id": "run-001",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "cli_message": {
        "type": "result",
        "subtype": "success",
        "result": "Fixed the bug and added tests.",
        "total_cost_usd": 0.12,
        "duration_ms": 45000
      }
    }
  }'
```

---

## Sending to Existing Threads

You can send messages to any thread that already exists in Funny (created from the UI or otherwise) using `thread_id`:

```bash
# Send a message to an existing thread — no request_id needed
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "thread_id": "abc123-existing-thread-id",
    "request_id": "",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "cli_message": {
        "type": "assistant",
        "message": {
          "id": "msg_ext_001",
          "content": [
            { "type": "text", "text": "External analysis result: all tests passing." }
          ]
        }
      }
    }
  }'
```

You can also use `*.accepted` with `thread_id` to "link" a run to an existing thread before streaming events:

```bash
# Link an external run to an existing thread
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.accepted",
    "request_id": "run-002",
    "thread_id": "abc123-existing-thread-id",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {}
  }'

# Now you can use either request_id or thread_id for subsequent events
curl -X POST http://localhost:3001/api/ingest/webhook \
  -H "X-Webhook-Secret: my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "agent.cli_message",
    "request_id": "run-002",
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "data": {
      "cli_message": {
        "type": "assistant",
        "message": {
          "id": "msg_003",
          "content": [{ "type": "text", "text": "Working on the linked thread..." }]
        }
      }
    }
  }'
```

---

## Thread Creation Options

When creating a thread with `*.accepted`, the following fields are available:

### `data` fields

| Field | Type | Default | Description |
|---|---|---|---|
| `title` | string | `External: <id>` | Thread title shown in sidebar |
| `prompt` | string | — | Initial user message |
| `model` | string | `sonnet` | Model label (`sonnet`, `opus`, `haiku`) |
| `branch` | string | — | Git branch name |
| `base_branch` | string | — | Base branch for diffs |
| `worktree_path` | string | — | Worktree directory (sets mode to `worktree`) |

### `metadata` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `projectId` | string | Yes* | Funny project ID to attach the thread to |
| `userId` | string | No | User ID (defaults to `__local__`) |
| `prompt` | string | No | Alternative location for initial prompt |

*`projectId` can be omitted if `worktree_path` matches a known project path.

---

## Finding Your Project ID

To get the project ID for `metadata.projectId`, look at the URL when you select a project in Funny, or query the API:

```bash
# List all projects (requires auth token in local mode)
curl http://localhost:3001/api/projects \
  -H "Authorization: Bearer $(cat ~/.funny/auth-token)"
```

---

## Responses

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ "status": "ok" }` | Event processed |
| `200` | `{ "status": "ok", "skipped": true }` | No `request_id` or `thread_id` — ignored |
| `400` | `{ "error": "..." }` | Invalid event structure |
| `401` | `{ "error": "Unauthorized" }` | Wrong or missing `X-Webhook-Secret` |
| `500` | `{ "error": "..." }` | Processing error (e.g. unknown `thread_id`) |
| `503` | `{ "error": "..." }` | `INGEST_WEBHOOK_SECRET` not configured |

---

## Full Lifecycle Example

Here's a complete example showing the typical sequence for an external agent:

```bash
SECRET="my-secret-token"
URL="http://localhost:3001/api/ingest/webhook"
RID="run-$(date +%s)"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 1. Create thread
curl -s -X POST $URL -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"event_type":"agent.accepted","request_id":"'$RID'","timestamp":"'$TS'","data":{"title":"Security Scan","prompt":"Scanning for vulnerabilities..."},"metadata":{"projectId":"YOUR_PROJECT_ID"}}'

# 2. Init (marks as running)
curl -s -X POST $URL -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"event_type":"agent.cli_message","request_id":"'$RID'","timestamp":"'$TS'","data":{"cli_message":{"type":"system","subtype":"init","session_id":"sess_001","tools":["Read","Grep"],"cwd":"/project"}}}'

# 3. Stream assistant messages
curl -s -X POST $URL -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"event_type":"agent.cli_message","request_id":"'$RID'","timestamp":"'$TS'","data":{"cli_message":{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Scanning all .ts files for SQL injection patterns..."}]}}}}'

# 4. Tool call
curl -s -X POST $URL -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"event_type":"agent.cli_message","request_id":"'$RID'","timestamp":"'$TS'","data":{"cli_message":{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t1","name":"Grep","input":{"pattern":"\\$\\{.*\\}","glob":"**/*.ts"}}]}}}}'

# 5. Tool result
curl -s -X POST $URL -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"event_type":"agent.cli_message","request_id":"'$RID'","timestamp":"'$TS'","data":{"cli_message":{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"src/db.ts:15: query(`SELECT * FROM users WHERE id = ${id}`)"}]}}}}'

# 6. Final result
curl -s -X POST $URL -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"event_type":"agent.cli_message","request_id":"'$RID'","timestamp":"'$TS'","data":{"cli_message":{"type":"result","subtype":"success","result":"Found 1 SQL injection vulnerability in src/db.ts:15","total_cost_usd":0.03,"duration_ms":8000}}}'
```

---

## Tips

- **Message IDs must be unique** within a thread. Use any string (`msg_001`, UUIDs, etc.). The same message ID sent twice will update the existing message (text accumulation).
- **Tool use IDs must be unique** within a thread. Duplicate tool_use IDs are deduplicated automatically.
- **Text accumulation**: Sending multiple `cli_message` events with the same `message.id` will replace the text content (not append). Send the full accumulated text each time.
- **The `*.completed`/`*.failed` events are fallbacks**: If you send a `cli_message` with `type: "result"`, the thread is already finalized. Subsequent `*.completed`/`*.failed` events for the same `request_id` are skipped.
- **Thread_id takes priority**: When both `thread_id` and `request_id` are present, `thread_id` is used for thread resolution.
