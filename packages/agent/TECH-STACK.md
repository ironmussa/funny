# Tech Stack: Pipeline Service

This document defines the specific libraries, frameworks, and tools for implementing the Pipeline Service described in [SAD.md](SAD.md).

---

## 1. Runtime and Language

| Component           | Choice         | Version        |
| ------------------- | -------------- | -------------- |
| **Runtime**         | Bun            | >= 1.2         |
| **Language**        | TypeScript     | (Bun built-in) |
| **Package Manager** | bun (built-in) | —              |
| **Module System**   | ESM            | —              |

**Why Bun:**

- Runs TypeScript natively — no `tsc`, no `tsx`, no compilation step for development
- Integrated package manager — `bun install` is ~25x faster than `npm install`
- `Bun.file()` and `Bun.write()` — Optimized filesystem API, faster than `node:fs/promises`
- `Bun.spawn()` — For launching processes (git, Claude Code CLI as fallback)
- Native global `fetch`
- Reads `.env` automatically — no `dotenv`
- Integrated test runner (`bun test`) — no Vitest or Jest
- Compatible with the npm ecosystem — all Node.js libraries work

**Why TypeScript:**

- The entire system relies on typed contracts (`PipelineRequest`, `PipelineEvent`)
- Adapters implement interfaces — TypeScript makes this verifiable at compile time
- Design patterns (Strategy, Command, State Machine) are expressed naturally with types

**What Bun eliminates from the stack:**
| Tool | Replaced by |
|---|---|
| `tsx` | Bun runs `.ts` directly |
| `dotenv` | Bun reads `.env` automatically |
| `@types/node` | Bun includes its own types |
| `vitest` / `jest` | `bun test` |
| `node:fs/promises` | `Bun.file()` / `Bun.write()` (though `node:fs` also works) |

---

## 2. HTTP Server

| Component      | Library               | Version |
| -------------- | --------------------- | ------- |
| **Framework**  | Hono                  | ^4      |
| **Validation** | `@hono/zod-validator` | ^0.4    |

Hono includes everything we need as built-in middleware — no external plugins:

| Feature     | Hono               | Where    |
| ----------- | ------------------ | -------- |
| CORS        | `hono/cors`        | Built-in |
| Bearer Auth | `hono/bearer-auth` | Built-in |
| SSE         | `hono/streaming`   | Built-in |
| Logger      | `hono/logger`      | Built-in |
| ETag        | `hono/etag`        | Built-in |

**Why Hono:**

|             | Express   | Fastify           | Hono                               |
| ----------- | --------- | ----------------- | ---------------------------------- |
| Size        | ~200kb    | ~100kb            | ~14kb                              |
| TypeScript  | Manual    | Good              | Native (written in TS)             |
| Validation  | External  | JSON Schema (Ajv) | Zod via `@hono/zod-validator`      |
| SSE         | Manual    | Plugin            | Built-in (`streamSSE`)             |
| CORS        | External  | Plugin            | Built-in                           |
| Auth        | External  | Plugin            | Built-in                           |
| Bun support | Works     | Works             | Optimized for Bun                  |
| API         | Callbacks | Async/await       | Method chaining, end-to-end typing |
| Runtimes    | Node.js   | Node.js           | Bun, Node, Deno, Workers, Lambda   |

Hono is designed for modern runtimes. With Bun, it doesn't need an adapter — it runs directly. Additionally, with `@hono/zod-validator`, validation uses Zod instead of JSON Schema, which means **a single validation system** (Zod) for both HTTP and business logic.

### Server configuration

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { logger } from 'hono/logger';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());
app.use('*', bearerAuth({ token: process.env.API_TOKEN! }));
```

### Validation with Zod (single validation system)

```typescript
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const PipelineRunSchema = z.object({
  branch: z.string().min(1),
  worktree_path: z.string().min(1),
  base_branch: z.string().default('main'),
  priority: z.number().int().min(1).max(10).optional(),
  depends_on: z.array(z.string()).optional(),
  config: z
    .object({
      tier_override: z.enum(['small', 'medium', 'large']).nullable().optional(),
      auto_correct: z.boolean().default(true),
      max_correction_attempts: z.number().int().default(3),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

app.post('/pipeline/run', zValidator('json', PipelineRunSchema), async (c) => {
  const body = c.req.valid('json'); // ← automatic typing from the Zod schema
  const requestId = crypto.randomUUID();

  // ... create PipelineRequest and launch pipeline

  return c.json(
    {
      request_id: requestId,
      status: 'accepted',
      pipeline_branch: `pipeline/${body.branch}`,
      events_url: `/pipeline/${requestId}/events`,
    },
    202,
  );
});
```

Hono + Zod validate the body and type it automatically. If the body doesn't match the schema, it responds with `400` without touching the handler. **A single schema** validates structure and business rules — no Ajv + Zod like in Fastify.

### SSE for event streaming

```typescript
import { streamSSE } from 'hono/streaming';

app.get('/pipeline/:requestId/events', (c) => {
  const requestId = c.req.param('requestId');

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'connected', data: JSON.stringify({ request_id: requestId }) });

    const handler = async (event: PipelineEvent) => {
      await stream.writeSSE({ event: event.event_type, data: JSON.stringify(event) });
    };

    eventBus.on(`pipeline.${requestId}`, handler);

    stream.onAbort(() => {
      eventBus.off(`pipeline.${requestId}`, handler);
    });

    // Keep the stream open
    while (true) {
      await stream.sleep(30_000);
      await stream.writeSSE({ event: 'ping', data: '' });
    }
  });
});
```

### Starting the server with Bun

```typescript
// src/server.ts
import { Hono } from 'hono';

const app = new Hono();
// ... routes ...

export default {
  port: config.adapters.inbound.rest_api.port,
  fetch: app.fetch,
};
```

Bun detects the `export default` with `fetch` and starts the server automatically. No `app.listen()`, no callbacks, no boilerplate.

For development: `bun --watch src/server.ts`
For production: `bun src/server.ts`

---

## 3. Claude Code Integration

| Component | Library                     | Version |
| --------- | --------------------------- | ------- |
| **SDK**   | `@anthropic-ai/claude-code` | latest  |

### Claude Agent SDK vs CLI subprocess

The architecture document defines that the Service "spawns Claude Code as a subprocess" (`claude -p "..."`). There are two ways to do this:

|            | CLI subprocess (`Bun.spawn`)          | Claude Agent SDK                             |
| ---------- | ------------------------------------- | -------------------------------------------- |
| Invocation | `Bun.spawn(['claude', '-p', prompt])` | `claude(prompt, { options })`                |
| Types      | No typing                             | Native TypeScript                            |
| Streaming  | Parse stdout manually                 | Typed events (`AssistantMessage`, `ToolUse`) |
| Session    | New session every time                | Can resume with `sessionId`                  |
| Tools      | Whatever the CLI has installed        | Can pass `allowedTools`                      |
| Errors     | Exit codes and stderr                 | Typed exceptions                             |
| Subagents  | The CLI handles them internally       | Visibility in events                         |

**Choice: Claude Agent SDK (`@anthropic-ai/claude-code`).**

The SDK provides full programmatic control. The Service can:

- Launch agents with specific prompts
- Receive streaming events (know when an agent uses a tool)
- Limit allowed tools per agent
- Handle errors with types
- Reuse sessions

### How the Pipeline Core runs

The Pipeline Core is a Claude Code process. The Service launches it with the SDK:

```typescript
import { claude, type MessageEvent } from '@anthropic-ai/claude-code';

async function runPipeline(request: PipelineRequest): Promise<void> {
  const prompt = buildPipelinePrompt(request);

  const events = claude(prompt, {
    cwd: request.worktree_path,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
    model: 'sonnet', // Sonnet for agents (cost/quality balance)
    maxTurns: 50,
    // Pipeline skills are in the worktree's CLAUDE.md
  });

  for await (const event of events) {
    // Each SDK event is translated to a PipelineEvent and emitted to the Event Bus
    if (event.type === 'assistant' && event.message) {
      eventBus.emit('pipeline.progress', {
        request_id: request.request_id,
        message: event.message,
      });
    }

    if (event.type === 'result') {
      // Parse final agent result
      const result = parsePipelineResult(event.result);
      eventBus.emit('pipeline.completed', {
        request_id: request.request_id,
        ...result,
      });
    }
  }
}
```

### How the 8 agents run in parallel

Claude Code natively supports parallel agent execution via the **Task tool**. The Service launches **a single Claude Code process** (the Pipeline Core), and this process uses `Task` to launch the 8 agents as concurrent subagents.

```
Service (Bun)
    |
    |  claude(prompt, { allowedTools: ['Task', ...] })
    |
    v
Pipeline Core (1 Claude Code process)
    |
    |  Uses the Task tool to launch 8 subagents in parallel
    |
    +-- Task(security-audit)         --+
    +-- Task(architecture-eval)      --+
    +-- Task(webapp-testing)         --+
    +-- Task(performance)            --+-- PARALLEL (Claude Code runs them concurrently)
    +-- Task(dependency-audit)       --+
    +-- Task(code-quality)           --+
    +-- Task(web-design-guidelines)  --+
    +-- Task(documentation-check)   --+
                                       |
                                       v
                              Core consolidates results
```

**Why a single process and not 8 SDK instances:**

|                 | 8 SDK instances                              | 1 process + Task tool                    |
| --------------- | -------------------------------------------- | ---------------------------------------- |
| Processes       | 8 separate Claude Code processes             | 1 process, N internal subagents          |
| Coordination    | Manual (`Promise.allSettled`) in the Service | Claude Code coordinates internally       |
| Consolidation   | The Service parses 8 results                 | The Core consolidates and decides        |
| Auto-correction | The Service must relaunch agents             | The Core retries internally              |
| Shared context  | Each agent starts without context            | Subagents inherit context from the Core  |
| Skills          | Must pass skills to each instance            | Skills are in the worktree (`CLAUDE.md`) |

The Pipeline Core is a Claude Code agent that **knows how to run the pipeline**. Its prompt tells it: "analyze this worktree, classify the tier, launch the necessary agents via Task, consolidate results, auto-correct if needed". The Service SDK only launches this process and listens to events.

### Pipeline Core prompt

The prompt that the Service passes to the Pipeline Core includes all the `PipelineRequest` information:

```typescript
function buildPipelinePrompt(request: PipelineRequest): string {
  return `
You are the Pipeline Core. Your job is to run the quality pipeline on this worktree.

## Request
- Branch: ${request.branch}
- Pipeline branch: pipeline/${request.branch}
- Base branch: ${request.base_branch}
- Tier override: ${request.config.tier_override ?? 'auto'}
- Auto-correct: ${request.config.auto_correct}
- Max correction attempts: ${request.config.max_correction_attempts}

## Instructions
1. Create the branch pipeline/${request.branch} from ${request.branch}
2. Analyze the change (git diff --stat) and classify the tier (Small/Medium/Large)
3. Launch the tier's agents using the Task tool — ALL IN PARALLEL
4. If blocking agents fail, auto-correct on the pipeline/ branch
5. Re-run only the failed agents (max ${request.config.max_correction_attempts} attempts)
6. When everything passes, merge back from pipeline/ to the original branch
7. Report the final result in JSON format

## Available agents (via Task tool)
- security-audit: Security analysis (BLOCKING)
- webapp-testing: Tests (BLOCKING)
- architecture-eval: Architecture evaluation (BLOCKING, tier medium+)
- dependency-audit: Dependency audit (BLOCKING, tier medium+)
- code-quality: Code quality (tier medium+)
- performance: Performance (tier large)
- web-design-guidelines: Accessibility (tier large, only if there are UI changes)
- documentation-check: Documentation (tier large)

Launch multiple Tasks in parallel in a single message.
  `.trim();
}
```

### What the Service sees via the SDK

The Service doesn't see the subagents directly. It sees the high-level events from the Claude Code process:

```typescript
async function runPipeline(request: PipelineRequest): Promise<void> {
  const prompt = buildPipelinePrompt(request);

  const events = claude(prompt, {
    cwd: request.worktree_path,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
    model: 'sonnet',
    maxTurns: 50,
  });

  for await (const event of events) {
    // The SDK emits events when the Core uses tools
    if (event.type === 'tool_use' && event.tool === 'Task') {
      // A subagent was launched
      eventBus.publish({
        event_type: 'pipeline.agent.started',
        request_id: request.request_id,
        data: { agent: event.input.description },
      });
    }

    if (event.type === 'result') {
      const result = parsePipelineResult(event.result);
      eventBus.publish({
        event_type: result.approved ? 'pipeline.completed' : 'pipeline.failed',
        request_id: request.request_id,
        data: result,
      });
    }
  }
}
```

### How the Director and Integrator run

The Director and Integrator are also Claude Code processes, but with different prompts and different tools:

```typescript
// Director — reads manifest, decides what to integrate
async function runDirector(): Promise<void> {
  const result = await claude(DIRECTOR_PROMPT, {
    cwd: projectRoot,
    allowedTools: ['Read', 'Bash', 'Write'],
    model: 'sonnet',
    maxTurns: 30,
  });

  // Parse Director decisions and execute
}

// Integrator — creates PRs, resolves conflicts
async function runIntegrator(branch: string): Promise<void> {
  const result = await claude(buildIntegratorPrompt(branch), {
    cwd: projectRoot,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    model: 'opus', // Opus for complex resolutions (conflicts, deduplication)
    maxTurns: 40,
  });
}
```

### Model per component

| Component              | Model  | Reason                                                                             |
| ---------------------- | ------ | ---------------------------------------------------------------------------------- |
| **Quality agents** (8) | Sonnet | Cost/speed balance. Well-defined tasks with skills.                                |
| **Auto-correction**    | Sonnet | Applies specific fixes based on clear findings.                                    |
| **Director**           | Sonnet | Decision logic on manifest + deps. Doesn't require deep reasoning.                 |
| **Integrator**         | Opus   | Conflict resolution, deduplication, semantic analysis. Requires complex reasoning. |

### Execution costs

Each pipeline runs multiple Claude calls. Agents run in parallel, which reduces time but not tokens.

| Tier       | Agents | Claude calls (approx)      | Model  |
| ---------- | ------ | -------------------------- | ------ |
| Small      | 2      | 2 agents + 0-3 corrections | Sonnet |
| Medium     | 5      | 5 agents + 0-3 corrections | Sonnet |
| Large      | 8      | 8 agents + 0-3 corrections | Sonnet |
| Integrator | 1      | 1 per branch               | Opus   |

---

## 4. Git Operations

| Component            | Library         | Usage |
| -------------------- | --------------- | ----- |
| **Programmatic Git** | `simple-git`    | ^3    |
| **GitHub API**       | `@octokit/rest` | ^21   |

### Why `simple-git` and not `Bun.spawn` + `git`

|           | `Bun.spawn` + raw git                            | `simple-git`                        |
| --------- | ------------------------------------------------ | ----------------------------------- |
| Interface | Strings (parse stdout)                           | Typed methods                       |
| Errors    | Exit codes                                       | Exceptions with context             |
| Branch    | `Bun.spawn(['git', 'checkout', '-b', name])`     | `git.checkoutBranch(name, start)`   |
| Diff      | Parse `git diff --stat` manually                 | `git.diffSummary()` → typed object  |
| Log       | Parse `git log --format=...`                     | `git.log({ maxCount: 10 })` → array |
| Merge     | `Bun.spawn(['git', 'merge', '--no-ff', branch])` | `git.merge([branch, '--no-ff'])`    |

`simple-git` wraps the system's `git` binary (it's not a reimplementation). It uses the installed `git`, but provides a TypeScript interface over the results.

### Usage in the Pipeline

```typescript
import simpleGit from 'simple-git';

const git = simpleGit(worktreePath);

// Tier classification
const diff = await git.diffSummary(['main...HEAD']);
const tier = classifyTier(diff.files.length, diff.insertions + diff.deletions);

// Create pipeline branch
await git.checkoutBranch(`pipeline/${branch}`, branch);

// Merge back after pipeline
await git.checkout(branch);
await git.merge([`pipeline/${branch}`, '--no-ff']);

// For the Integrator
await git.checkoutBranch(`integration/${branch}`, 'main');
await git.merge([`pipeline/${branch}`, '--no-ff']);
```

### GitHub API with @octokit/rest

```typescript
import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Create PR (Integrator)
const { data: pr } = await octokit.pulls.create({
  owner,
  repo,
  title: `Integrate: ${branch}`,
  head: `integration/${branch}`,
  base: 'main',
  body: generatePRBody(pipelineResults),
});

// Comment on PR
await octokit.issues.createComment({
  owner,
  repo,
  issue_number: pr.number,
  body: '✅ Pipeline passed. Ready for review.',
});

// Add labels
await octokit.issues.addLabels({
  owner,
  repo,
  issue_number: pr.number,
  labels: ['pipeline-approved'],
});
```

### When to use `@octokit` vs `simple-git`

| Operation             | Tool              | Reason                                             |
| --------------------- | ----------------- | -------------------------------------------------- |
| Create PR             | `@octokit/rest`   | Typed response, full control over body             |
| Comment on PR         | `@octokit/rest`   | Programmatic, no stdout parsing                    |
| Check PR status       | `@octokit/rest`   | Typed JSON                                         |
| Force push with lease | `simple-git`      | `git push --force-with-lease` (not a GitHub API)   |
| Receive webhooks      | Hono (the server) | The Service exposes an endpoint, GitHub sends POST |

**Rule:** Use `@octokit/rest` for everything that is GitHub API. Use `simple-git` for local git operations.

---

## 5. Event Bus

| Component               | Library                      | Usage               |
| ----------------------- | ---------------------------- | ------------------- |
| **Local**               | `eventemitter3`              | In-memory Event Bus |
| **Persistence**         | `Bun.write()` / `Bun.file()` | Write/read JSONL    |
| **Scalable (optional)** | `ioredis`                    | Redis Pub/Sub       |
| **Scalable (optional)** | `nats`                       | NATS messaging      |

### Why `eventemitter3` and not `node:events`

|              | `node:events`           | `eventemitter3`     |
| ------------ | ----------------------- | ------------------- |
| Performance  | Good                    | ~3x faster          |
| TypeScript   | Basic generics          | Full generics       |
| Memory leaks | Warning at 10 listeners | No artificial limit |
| Bun compat   | Yes                     | Yes                 |

`eventemitter3` is a drop-in replacement for `EventEmitter` with better performance and typing. The API is identical.

### Event Bus implementation

```typescript
import EventEmitter from 'eventemitter3';

interface EventBusEvents {
  'pipeline.started': (event: PipelineEvent) => void;
  'pipeline.agent.completed': (event: PipelineEvent) => void;
  'pipeline.round.completed': (event: PipelineEvent) => void;
  'pipeline.correction.started': (event: PipelineEvent) => void;
  'pipeline.correction.completed': (event: PipelineEvent) => void;
  'pipeline.completed': (event: PipelineEvent) => void;
  'pipeline.failed': (event: PipelineEvent) => void;
  'pipeline.error': (event: PipelineEvent) => void;
  'director.activated': (event: PipelineEvent) => void;
  'integration.pr.created': (event: PipelineEvent) => void;
  'integration.pr.merged': (event: PipelineEvent) => void;
  // ... all events from the catalog
}

class PipelineEventBus extends EventEmitter<EventBusEvents> {
  private persistPath: string;

  constructor(persistPath: string) {
    super();
    this.persistPath = persistPath;
  }

  async publish(event: PipelineEvent): Promise<void> {
    // 1. Persist to JSONL (Bun.write with append)
    const file = Bun.file(`${this.persistPath}/${event.request_id}.jsonl`);
    const existing = (await file.exists()) ? await file.text() : '';
    await Bun.write(file, existing + JSON.stringify(event) + '\n');

    // 2. Emit to all in-memory subscribers
    this.emit(event.event_type as keyof EventBusEvents, event);
  }
}
```

### Scaling to Redis (when needed)

If the Service needs to run on multiple instances, the Event Bus can be switched to Redis without modifying the adapters:

```typescript
import Redis from 'ioredis';

class RedisEventBus extends EventEmitter<EventBusEvents> {
  private pub: Redis;
  private sub: Redis;

  constructor(redisUrl: string) {
    super();
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);

    this.sub.on('message', (channel, message) => {
      const event = JSON.parse(message) as PipelineEvent;
      this.emit(event.event_type as keyof EventBusEvents, event);
    });
  }

  async publish(event: PipelineEvent): Promise<void> {
    await this.pub.publish('pipeline-events', JSON.stringify(event));
  }
}
```

The change is an adapter — the components that use `eventBus.on()` and `eventBus.publish()` don't change.

---

## 6. Logging

| Component              | Library       | Version |
| ---------------------- | ------------- | ------- |
| **Logger**             | Pino          | ^9      |
| **Pretty print (dev)** | `pino-pretty` | ^13     |

### Why Pino

|                  | Winston                   | Pino                          | Bunyan      |
| ---------------- | ------------------------- | ----------------------------- | ----------- |
| Performance      | ~5k logs/s                | ~100k logs/s                  | ~10k logs/s |
| Native format    | String → JSON (transform) | Native JSON                   | Native JSON |
| Overhead in prod | High (formatters)         | Minimal (only JSON.stringify) | Medium      |
| Child loggers    | Yes                       | Yes, with inherited fields    | Yes         |

Pino produces JSON by default — exactly the format we defined in the architecture. No transformation. Each log entry is a JSON line.

### Integration with the logging system

The log format defined in the architecture is:

```json
{
  "timestamp": "2026-02-14T12:00:01.234Z",
  "level": "info",
  "source": "core.agent.security",
  "request_id": "abc-123",
  "action": "scan.file",
  "message": "Scanning auth.ts for vulnerabilities",
  "data": { "file": "src/auth.ts" },
  "duration_ms": 3200
}
```

Pino supports this natively with child loggers:

```typescript
import pino from 'pino';

// System base logger
const systemLogger = pino({
  level: config.logging.level,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined, // Don't include hostname/pid
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

// Child logger for a specific pipeline
function createPipelineLogger(requestId: string): pino.Logger {
  return systemLogger.child({ request_id: requestId });
}

// Child logger for a specific component
function createSourceLogger(source: string, requestId?: string): pino.Logger {
  return systemLogger.child({
    source,
    ...(requestId ? { request_id: requestId } : {}),
  });
}

// Usage
const log = createSourceLogger('core.agent.security', 'abc-123');
log.info(
  { action: 'scan.file', data: { file: 'src/auth.ts' }, duration_ms: 3200 },
  'Scanning auth.ts',
);
// Produces: {"timestamp":"2026-...","level":"info","source":"core.agent.security","request_id":"abc-123","action":"scan.file","message":"Scanning auth.ts","data":{"file":"src/auth.ts"},"duration_ms":3200}
```

### Writing to files by request_id

Pino writes to stdout by default. To separate logs by `request_id` + system, we use a custom transport:

```typescript
// Custom transport that separates by request_id
const transport = pino.transport({
  target: './log-splitter.ts',
  options: {
    basePath: config.logging.path,
  },
});

const logger = pino(transport);
```

```typescript
// log-splitter.ts — Custom Pino transport
import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import build from 'pino-abstract-transport';

export default async function (opts: { basePath: string }) {
  const streams = new Map<string, ReturnType<typeof createWriteStream>>();

  return build(async function (source) {
    for await (const obj of source) {
      const date = new Date().toISOString().split('T')[0];
      const dir = `${opts.basePath}/${date}`;
      await mkdir(dir, { recursive: true });

      const file = obj.request_id ? `${dir}/${obj.request_id}.jsonl` : `${dir}/system.jsonl`;

      if (!streams.has(file)) {
        streams.set(file, createWriteStream(file, { flags: 'a' }));
      }

      streams.get(file)!.write(JSON.stringify(obj) + '\n');
    }
  });
}
```

### Hono middleware for HTTP logging

Hono has a `logger()` middleware that logs HTTP requests. To integrate it with Pino:

```typescript
import { logger as honoLogger } from 'hono/logger';

// Option 1: use Hono's built-in logger (simple, to stdout)
app.use('*', honoLogger());

// Option 2: custom middleware that uses Pino
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  pinoLogger.info(
    {
      source: 'inbound.rest',
      action: 'request.completed',
      data: {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
      },
      duration_ms: duration,
    },
    `${c.req.method} ${c.req.path} → ${c.res.status}`,
  );
});
```

---

## 7. Design Patterns: Libraries per Pattern

### 7.1 Adapter — No library

Adapters are custom code. They are TypeScript classes that implement an interface. They don't need a library.

```typescript
// Port (interface)
interface InboundPort {
  toPipelineRequest(raw: unknown): PipelineRequest;
}

// Concrete adapter
class RestAdapter implements InboundPort {
  toPipelineRequest(raw: unknown): PipelineRequest {
    return {
      request_id: crypto.randomUUID(),
      branch: (raw as any).branch,
      worktree_path: (raw as any).worktree_path,
      // ...
    };
  }
}
```

No library is needed because the pattern is a code structure, not a tool.

### 7.2 Observer / Pub-Sub — `eventemitter3`

Already covered in section 5 (Event Bus). `eventemitter3` is all the library we need.

### 7.3 Command — No library

`PipelineRequest` is the command. It's a plain JSON object that is serialized, persisted, and queued. It doesn't need a library.

```typescript
interface PipelineRequest {
  request_id: string;
  branch: string;
  worktree_path: string;
  base_branch: string;
  config: PipelineConfig;
  metadata: Record<string, unknown>;
}
```

### 7.4 Strategy — No library

The Strategy pattern is implemented with a function map:

```typescript
type TierStrategy = {
  name: 'small' | 'medium' | 'large';
  agents: AgentName[];
};

const TIER_STRATEGIES: Record<string, TierStrategy> = {
  small: { name: 'small', agents: ['tests', 'security'] },
  medium: {
    name: 'medium',
    agents: ['tests', 'security', 'architecture', 'dependencies', 'code_quality'],
  },
  large: {
    name: 'large',
    agents: [
      'tests',
      'security',
      'architecture',
      'dependencies',
      'code_quality',
      'performance',
      'accessibility',
      'documentation',
    ],
  },
};

function selectTier(diff: DiffSummary, override?: string): TierStrategy {
  if (override) return TIER_STRATEGIES[override];
  if (diff.files.length > 10 || diff.lines > 300) return TIER_STRATEGIES.large;
  if (diff.files.length > 3 || diff.lines > 50) return TIER_STRATEGIES.medium;
  return TIER_STRATEGIES.small;
}
```

No library needed. It's pure logic.

### 7.5 State Machine — `xstate`

| Component         | Library  | Version |
| ----------------- | -------- | ------- |
| **State Machine** | `xstate` | ^5      |

**Why `xstate`:**

- It's the industry standard for state machines in JavaScript/TypeScript
- Prevents invalid transitions by definition
- Visualizable (there are tools to generate diagrams from the statechart)
- Persists current state (for recovery after crash)
- TypeScript-first since v5

**Manifest state machine:**

```typescript
import { createMachine, createActor } from 'xstate';

const branchMachine = createMachine({
  id: 'branch',
  initial: 'running',
  states: {
    running: {
      on: {
        PIPELINE_APPROVED: 'ready',
        PIPELINE_FAILED: 'failed',
      },
    },
    ready: {
      on: {
        PR_CREATED: 'pending_merge',
      },
    },
    pending_merge: {
      on: {
        PR_MERGED: 'merge_history',
        PR_CLOSED: 'ready', // Retry
        PR_STALE: 'pending_merge', // Rebase and stay in pending
      },
    },
    merge_history: {
      type: 'final',
    },
    failed: {
      // Terminal — requires intervention
    },
  },
});

// Usage
const actor = createActor(branchMachine).start();
actor.send({ type: 'PIPELINE_APPROVED' });
console.log(actor.getSnapshot().value); // 'ready'

// Invalid transition → does nothing (safe by design)
actor.send({ type: 'PR_MERGED' }); // Ignored — there's no ready → merge_history transition
```

**State persistence:**

`xstate` can serialize state with `actor.getPersistedSnapshot()` and restore it with `createActor(machine, { snapshot })`. This allows recovery after a Service crash.

### 7.6 Saga — Custom implementation

There's no Saga library for Node.js/Bun that fits our flow. Existing libraries are oriented toward microservices with message brokers. Our case is simpler: a sequential process with compensation.

```typescript
interface SagaStep {
  name: string;
  execute: () => Promise<void>;
  compensate: () => Promise<void>;
}

class Saga {
  private steps: SagaStep[] = [];
  private completedSteps: string[] = [];
  private persistPath: string;

  constructor(requestId: string, persistPath: string) {
    this.persistPath = `${persistPath}/${requestId}.json`;
  }

  addStep(step: SagaStep): void {
    this.steps.push(step);
  }

  async execute(): Promise<void> {
    for (const step of this.steps) {
      try {
        await step.execute();
        this.completedSteps.push(step.name);
        await this.persist();
      } catch (error) {
        await this.compensate();
        throw error;
      }
    }
  }

  private async compensate(): Promise<void> {
    // Compensate in reverse order
    for (const stepName of [...this.completedSteps].reverse()) {
      const step = this.steps.find((s) => s.name === stepName);
      if (step) {
        await step.compensate();
      }
    }
  }

  private async persist(): Promise<void> {
    await Bun.write(
      this.persistPath,
      JSON.stringify({
        steps_completed: this.completedSteps,
        current_step: this.steps[this.completedSteps.length]?.name ?? null,
        updated_at: new Date().toISOString(),
      }),
    );
  }
}
```

**Usage in the pipeline:**

```typescript
const saga = new Saga(request.request_id, config.saga.persistence_path)

saga.addStep({
  name: 'create_branch',
  execute: () => git.checkoutBranch(`pipeline/${branch}`, branch),
  compensate: () => git.deleteLocalBranch(`pipeline/${branch}`, true)
})

saga.addStep({
  name: 'run_agents',
  execute: () => runAgents(request, tier),
  compensate: () => eventBus.publish({ event_type: 'pipeline.error', ... })
})

saga.addStep({
  name: 'merge_back',
  execute: () => git.checkout(branch).then(() => git.merge([`pipeline/${branch}`])),
  compensate: () => {} // Keep pipeline/ for debugging
})

await saga.execute()
```

### 7.7 Idempotency — In-memory `Map` + file

No library needed. It's a `Map<string, string>` that maps `branch` to `request_id`:

```typescript
class IdempotencyGuard {
  private activePipelines = new Map<string, string>(); // branch → request_id

  check(branch: string): { isDuplicate: boolean; existingRequestId?: string } {
    const existing = this.activePipelines.get(branch);
    if (existing) {
      return { isDuplicate: true, existingRequestId: existing };
    }
    return { isDuplicate: false };
  }

  register(branch: string, requestId: string): void {
    this.activePipelines.set(branch, requestId);
  }

  release(branch: string): void {
    this.activePipelines.delete(branch);
  }
}
```

It's periodically persisted with `Bun.write('.pipeline/active-pipelines.json', ...)` for recovery after crash.

### 7.8 Circuit Breaker — `cockatiel`

| Component           | Library     | Version |
| ------------------- | ----------- | ------- |
| **Circuit Breaker** | `cockatiel` | ^3      |

**Why `cockatiel` and not `opossum`:**

|             | `opossum`                            | `cockatiel`                     |
| ----------- | ------------------------------------ | ------------------------------- |
| TypeScript  | Basic typing                         | TypeScript-first, full generics |
| API         | Class-based (new CircuitBreaker(fn)) | Composable policies (wrap)      |
| Retry       | Separate                             | Integrated in the same library  |
| Bulkhead    | No                                   | Yes                             |
| Size        | 25kb                                 | 12kb                            |
| Maintenance | Active                               | Active (Microsoft)              |

`cockatiel` doesn't just provide Circuit Breaker — it also provides Retry, Timeout, and Bulkhead. These are the resilience patterns we need, all in a single library.

```typescript
import { CircuitBreakerPolicy, ConsecutiveBreaker, retry, handleAll, wrap } from 'cockatiel';

// Circuit breaker for Claude Code
const claudeBreaker = new CircuitBreakerPolicy(
  handleAll,
  new ConsecutiveBreaker(3), // Open after 3 consecutive failures
);

claudeBreaker.onBreak(() => {
  logger.error({ source: 'circuit-breaker', action: 'circuit.open' }, 'Claude Code circuit OPEN');
});

claudeBreaker.onReset(() => {
  logger.info(
    { source: 'circuit-breaker', action: 'circuit.closed' },
    'Claude Code circuit CLOSED',
  );
});

// Circuit breaker for GitHub API
const githubBreaker = new CircuitBreakerPolicy(handleAll, new ConsecutiveBreaker(5));

// Retry + Circuit breaker combined
const githubPolicy = wrap(retry(handleAll, { maxAttempts: 3 }), githubBreaker);

// Usage
const pr = await githubPolicy.execute(() =>
  octokit.pulls.create({ owner, repo, title, head, base, body }),
);
```

### 7.9 Dead Letter Queue — Custom implementation + `Bun.file()`

There are no standalone DLQ libraries (DLQs live inside message brokers like RabbitMQ). Our DLQ is file-based:

```typescript
import { readdir, mkdir } from 'node:fs/promises';

class DeadLetterQueue {
  private basePath: string;
  private maxRetries: number;
  private baseDelay: number;

  constructor(config: DLQConfig) {
    this.basePath = config.path;
    this.maxRetries = config.max_retries;
    this.baseDelay = config.base_delay_seconds * 1000;
  }

  async enqueue(adapter: string, event: PipelineEvent, error: Error): Promise<void> {
    const dir = `${this.basePath}/${adapter}`;
    await mkdir(dir, { recursive: true });

    const entry = {
      event,
      error: error.message,
      enqueued_at: new Date().toISOString(),
      retry_count: 0,
      next_retry_at: new Date(Date.now() + this.baseDelay).toISOString(),
    };

    const file = Bun.file(`${dir}/${event.request_id}.jsonl`);
    const existing = (await file.exists()) ? await file.text() : '';
    await Bun.write(file, existing + JSON.stringify(entry) + '\n');
  }

  async processRetries(
    adapter: string,
    deliverFn: (event: PipelineEvent) => Promise<void>,
  ): Promise<void> {
    const dir = `${this.basePath}/${adapter}`;
    const files = await readdir(dir).catch(() => []);

    for (const fileName of files) {
      const file = Bun.file(`${dir}/${fileName}`);
      const content = await file.text();
      const entries = content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const latest = entries[entries.length - 1];

      if (latest.retry_count >= this.maxRetries) {
        eventBus.publish({
          event_type: 'adapter.delivery.failed',
          data: { adapter, event: latest.event, retries_exhausted: true },
        });
        continue;
      }

      if (new Date(latest.next_retry_at) <= new Date()) {
        try {
          await deliverFn(latest.event);
          await Bun.write(`${dir}/${fileName}`, ''); // Delivered — clear
        } catch (retryError) {
          const delay = this.baseDelay * Math.pow(3, latest.retry_count); // Exponential backoff
          const retryEntry = {
            ...latest,
            retry_count: latest.retry_count + 1,
            next_retry_at: new Date(Date.now() + delay).toISOString(),
            last_error: (retryError as Error).message,
          };
          await Bun.write(file, content + JSON.stringify(retryEntry) + '\n');
        }
      }
    }
  }
}
```

---

## 8. Configuration

| Component                 | Library        | Version |
| ------------------------- | -------------- | ------- |
| **YAML parser**           | `yaml`         | ^2      |
| **Validation**            | `zod`          | ^3      |
| **Environment variables** | Bun (built-in) | —       |

Bun reads `.env` automatically. We don't need `dotenv`.

### Why `yaml` and not `js-yaml`

|                   | `js-yaml`      | `yaml`                      |
| ----------------- | -------------- | --------------------------- |
| Spec              | YAML 1.1       | YAML 1.2 (current standard) |
| TypeScript        | External types | Native TypeScript           |
| Preserve comments | No             | Yes                         |
| Maintenance       | Active         | Active                      |

### Configuration flow

```typescript
import { parse } from 'yaml';
import { z } from 'zod';

// Configuration schema with Zod
const ConfigSchema = z.object({
  pipeline: z.object({
    branch: z.object({
      prefix: z.string().default('pipeline/'),
      merge_back: z.boolean().default(true),
      delete_after_merge: z.boolean().default(true),
      keep_on_failure: z.boolean().default(true),
    }),
    tiers: z.object({
      small: z.object({
        max_files: z.number().default(3),
        max_lines: z.number().default(50),
        agents: z.array(z.string()),
      }),
      medium: z.object({
        max_files: z.number().default(10),
        max_lines: z.number().default(300),
        agents: z.array(z.string()),
      }),
      large: z.object({
        agents: z.array(z.string()),
      }),
    }),
    // ... rest of the schema
  }),
});

type PipelineConfig = z.infer<typeof ConfigSchema>;

async function loadConfig(projectRoot: string): Promise<PipelineConfig> {
  const file = Bun.file(`${projectRoot}/.pipeline/config.yaml`);
  const raw = await file.text();
  const parsed = parse(raw);

  // Resolve environment variables (${VAR_NAME})
  const resolved = resolveEnvVars(parsed);

  // Validate against the schema
  return ConfigSchema.parse(resolved);
}
```

### Environment variable resolution

The config.yaml uses `${VAR_NAME}` for secrets. They are resolved at load time. Bun already has the `.env` variables in `process.env`:

```typescript
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveEnvVars(v)]));
  }
  return obj;
}
```

---

## 9. Schema Validation

| Component          | Library | Version |
| ------------------ | ------- | ------- |
| **All validation** | `zod`   | ^3      |

With Hono + `@hono/zod-validator`, **Zod is the single validation system**. There are no two levels (Ajv + Zod like in Fastify). A single Zod schema validates both HTTP structure and business rules.

```typescript
// A single schema — validates structure AND business rules
const PipelineRunSchema = z.object({
  branch: z
    .string()
    .min(1)
    .refine((branch) => !branch.startsWith('pipeline/'), 'Branch cannot start with pipeline/'),
  worktree_path: z.string().min(1),
  base_branch: z.string().default('main'),
  config: z
    .object({
      tier_override: z.enum(['small', 'medium', 'large']).nullable().optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Used directly in the endpoint
app.post('/pipeline/run', zValidator('json', PipelineRunSchema), handler);
```

---

## 10. Webhook HTTP Client

| Component       | Library              | Version |
| --------------- | -------------------- | ------- |
| **HTTP client** | `fetch` (Bun global) | —       |

Bun has a native global `fetch`. We don't need `axios`, `got`, or `node-fetch`.

```typescript
// Send webhook to client
async function sendWebhook(url: string, event: PipelineEvent, token: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Pipeline-Event': event.event_type,
      'X-Request-ID': event.request_id,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
  }
}
```

---

## 11. Filesystem and JSONL

| Component         | Tool                         | Detail              |
| ----------------- | ---------------------------- | ------------------- |
| **File I/O**      | `Bun.file()` / `Bun.write()` | Bun's optimized API |
| **JSONL parsing** | Custom implementation        | —                   |
| **File watching** | `chokidar`                   | ^4                  |

### JSONL read/write with Bun

```typescript
// Write (append)
async function appendJsonl(path: string, obj: unknown): Promise<void> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  await Bun.write(file, existing + JSON.stringify(obj) + '\n');
}

// Read
async function readJsonl<T>(path: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const content = await file.text();
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

// Read by streaming (large files)
async function* streamJsonl<T>(path: string): AsyncGenerator<T> {
  const file = Bun.file(path);
  const stream = file.stream();
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as T;
    }
  }

  if (buffer.trim()) yield JSON.parse(buffer) as T;
}
```

### File watching with `chokidar`

To detect when manifest.json changes (useful if external processes modify it):

```typescript
import chokidar from 'chokidar';

chokidar.watch('.pipeline/manifest.json').on('change', () => {
  // Re-read manifest and notify the Director
});
```

---

## 12. Testing

| Component        | Tool                            | Detail          |
| ---------------- | ------------------------------- | --------------- |
| **Test runner**  | `bun test` (built-in)           | —               |
| **HTTP testing** | `app.request()` (Hono built-in) | —               |
| **Mocks**        | `bun:test` (built-in)           | `mock`, `spyOn` |

### Why `bun test`

Bun includes a test runner that is compatible with Jest/Vitest syntax. Nothing needs to be installed.

|              | Jest                 | Vitest          | `bun test`               |
| ------------ | -------------------- | --------------- | ------------------------ |
| TypeScript   | Via ts-jest          | Via esbuild     | Native                   |
| Speed        | Slow                 | Fast            | Faster (native)          |
| Installation | `npm i jest ts-jest` | `npm i vitest`  | Already included         |
| Mocks        | `jest.mock()`        | `vi.mock()`     | `mock()` from `bun:test` |
| Watch        | `--watch`            | `--watch` (HMR) | `--watch`                |

### HTTP server testing

Hono includes `app.request()` for testing endpoints without starting the server:

```typescript
import { test, expect } from 'bun:test';
import { app } from '../src/server';

test('POST /pipeline/run returns 202', async () => {
  const response = await app.request('/pipeline/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify({
      branch: 'feature/auth',
      worktree_path: '/tmp/test-worktree',
    }),
  });

  expect(response.status).toBe(202);
  const json = await response.json();
  expect(json).toHaveProperty('request_id');
});
```

### Pattern testing

```typescript
import { test, expect } from 'bun:test';

// State Machine
test('branch cannot skip from ready to merge_history', () => {
  const actor = createActor(branchMachine).start();
  actor.send({ type: 'PIPELINE_APPROVED' }); // → ready
  actor.send({ type: 'PR_MERGED' }); // Invalid transition

  expect(actor.getSnapshot().value).toBe('ready'); // Didn't change
});

// Circuit Breaker
test('circuit opens after 3 consecutive failures', async () => {
  const breaker = new CircuitBreakerPolicy(handleAll, new ConsecutiveBreaker(3));

  const failingFn = () => {
    throw new Error('fail');
  };

  for (let i = 0; i < 3; i++) {
    await breaker.execute(failingFn).catch(() => {});
  }

  expect(breaker.execute(failingFn)).rejects.toThrow('Breaker'); // Circuit open
});

// Saga compensation
test('saga compensates on failure', async () => {
  const compensated: string[] = [];
  const saga = new Saga('test-123', '/tmp');

  saga.addStep({
    name: 'step1',
    execute: async () => {},
    compensate: async () => {
      compensated.push('step1');
    },
  });
  saga.addStep({
    name: 'step2',
    execute: async () => {
      throw new Error('boom');
    },
    compensate: async () => {
      compensated.push('step2');
    },
  });

  expect(saga.execute()).rejects.toThrow('boom');
  expect(compensated).toEqual(['step1']); // step2 was never executed, step1 was compensated
});
```

---

## 13. Dependency Summary

### Production dependencies

| Library                     | Version | Pattern / Component | Purpose                              |
| --------------------------- | ------- | ------------------- | ------------------------------------ |
| `hono`                      | ^4      | HTTP Server         | Ultra-lightweight web framework      |
| `@hono/zod-validator`       | ^0.4    | HTTP Validation     | Zod validation in endpoints          |
| `@anthropic-ai/claude-code` | latest  | Claude Code         | SDK for launching Claude Code agents |
| `simple-git`                | ^3      | Git                 | Programmatic git operations          |
| `@octokit/rest`             | ^21     | GitHub              | GitHub API (PRs, comments, labels)   |
| `eventemitter3`             | ^5      | Observer/Pub-Sub    | In-memory Event Bus                  |
| `pino`                      | ^9      | Logging             | Structured JSON logging              |
| `xstate`                    | ^5      | State Machine       | Manifest state machine               |
| `cockatiel`                 | ^3      | Circuit Breaker     | Resilience (circuit breaker + retry) |
| `yaml`                      | ^2      | Configuration       | YAML 1.2 parser                      |
| `zod`                       | ^3      | Validation          | Runtime schema validation            |
| `chokidar`                  | ^4      | Filesystem          | File watching                        |

### Development dependencies

| Library                   | Version | Purpose                             |
| ------------------------- | ------- | ----------------------------------- |
| `pino-pretty`             | ^13     | Pretty print of logs in development |
| `pino-abstract-transport` | ^2      | Base for custom Pino transport      |

### Optional dependencies (scaling)

| Library   | Version | When                  | Purpose        |
| --------- | ------- | --------------------- | -------------- |
| `ioredis` | ^5      | Distributed Event Bus | Redis Pub/Sub  |
| `nats`    | ^2      | Enterprise Event Bus  | NATS messaging |

---

## 14. Dependency Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          PIPELINE SERVICE (Bun)                          │
│                                                                          │
│  ┌─ SERVER ───────────────────────────────────────────────────────────┐  │
│  │  hono + @hono/zod-validator                                        │  │
│  │  (CORS, Auth, SSE, Logger → Hono built-in)                        │  │
│  └────────────────────────────────────┬───────────────────────────────┘  │
│                                       │                                  │
│  ┌─ CORE ─────────────────────────────┼────────────────────────────┐    │
│  │                                    │                             │    │
│  │  @anthropic-ai/claude-code ────── Launches agents               │    │
│  │  simple-git ──────────────────── Git operations                 │    │
│  │  @octokit/rest ───────────────── GitHub API                     │    │
│  │  zod ─────────────────────────── Business validation            │    │
│  │                                                                  │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                       │                                  │
│  ┌─ EVENT BUS ────────────────────────┼────────────────────────────┐    │
│  │  eventemitter3 ───────────────── In-memory Pub/Sub              │    │
│  │  Bun.file() / Bun.write() ────── JSONL persistence             │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                       │                                  │
│  ┌─ PATTERNS ─────────────────────────┼────────────────────────────┐    │
│  │  xstate ──────────────────────── Manifest state machine         │    │
│  │  cockatiel ───────────────────── Circuit breaker + retry         │    │
│  │  (custom) ────────────────────── Saga, Idempotency, DLQ         │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                       │                                  │
│  ┌─ CONFIG ───────────────────────────┼────────────────────────────┐    │
│  │  yaml ────────────────────────── config.yaml parser             │    │
│  │  Bun (.env) ──────────────────── Environment variables          │    │
│  │  zod ─────────────────────────── Schema validation               │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                       │                                  │
│  ┌─ LOGGING ──────────────────────────┼────────────────────────────┐    │
│  │  pino ────────────────────────── JSON logger                    │    │
│  │  pino-pretty ─────────────────── Development                     │    │
│  │  (custom transport) ─────────── Separate logs by request_id      │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 15. package.json

```json
{
  "name": "pipeline-service",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "start": "bun src/server.ts",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "typecheck": "bun x tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4",
    "@hono/zod-validator": "^0.4",
    "@anthropic-ai/claude-code": "latest",
    "simple-git": "^3",
    "@octokit/rest": "^21",
    "eventemitter3": "^5",
    "pino": "^9",
    "xstate": "^5",
    "cockatiel": "^3",
    "yaml": "^2",
    "zod": "^3",
    "chokidar": "^4"
  },
  "devDependencies": {
    "pino-pretty": "^13",
    "pino-abstract-transport": "^2"
  }
}
```

**Total: 12 production dependencies, 2 development dependencies.** Bun eliminates 6 dependencies that Node.js needed (`dotenv`, `tsx`, `typescript`, `@types/node`, `vitest`, Fastify plugins). Hono eliminates 3 more (CORS, Auth, SSE as plugins).
