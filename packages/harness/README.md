# @funny/harness

Experimental public harness for authoring funny agents, sessions, tools,
workflows, and sandbox intent without importing the funny server/runtime app.

The package is intentionally a facade:

- Agent execution delegates to a `HarnessRuntime`.
- Workflows run on `@funny/pipelines`.
- Local process execution uses `@funny/core`.
- Runner-level cloud sandbox lifecycle stays in `cloud-sandbox-runners`.

## Direct agent prompt

```ts
import { createAgent, createLocalRuntime, createSession } from '@funny/harness';

const runtime = createLocalRuntime();
const agent = createAgent({
  provider: 'claude',
  model: 'sonnet',
  instructions: 'Review code changes and return concise findings.',
  permissionMode: 'plan',
});

const session = createSession({
  agent,
  runtime,
  cwd: process.cwd(),
});

const result = await session.prompt('Review the current diff.');
console.log(result.output);
```

## Session continuation

```ts
const session = createSession({
  agent,
  runtime,
  cwd: process.cwd(),
  sessionId: 'provider-session-id',
});

await session.prompt('Continue from the previous context.');
```

## Custom tools

```ts
import { createToolRegistry, defineTool } from '@funny/harness';
import { z } from 'zod';

const readTicket = defineTool({
  name: 'read_ticket',
  description: 'Load a ticket by id.',
  inputSchema: z.object({ id: z.string() }),
  handler: async ({ id }) => ({ id, title: 'Example' }),
});

const tools = createToolRegistry([readTicket]);
const ticket = await tools.invoke('read_ticket', { id: 'T-1' });
```

Agent sessions require runtime support to expose custom tools to the provider.
Workflows can always invoke registered tools directly.

## Workflow

```ts
import { defineWorkflow, runWorkflow } from '@funny/harness';

const workflow = defineWorkflow({
  name: 'review-change',
  steps: [
    {
      name: 'load-ticket',
      execute: async (ctx) => {
        const ticket = await ctx.tools.invoke('read_ticket', { id: 'T-1' }, { cwd: ctx.cwd });
        return { ...ctx, ticket };
      },
    },
  ],
});

await runWorkflow(workflow, {
  cwd: process.cwd(),
  runtime,
  tools,
});
```

## Sandbox intent

The harness models sandbox intent at three different altitudes:

```txt
local
  runs on the current runtime host

process
  sandboxes only the agent subprocess
  maps to SandboxManager / spawnClaudeCodeProcess when the runtime supports it

runner
  sandboxes the entire funny runner
  maps to cloud-sandbox-runners / RunnerProvisioner when available
```

```ts
import { sandbox } from '@funny/harness';

const local = sandbox.local();
const processSandbox = sandbox.process({ isolation: 'podman' });
const runnerSandbox = sandbox.runner({ provider: 'default' });
```

`@funny/harness` does not import E2B, Modal, or provider SDKs. Provider
selection, provider keys, pause/resume, snapshot, restore, idle lifecycle, and
billing behavior belong to the `cloud-sandbox-runners` provisioner layer.

## Runnable fake-runtime example

```ts
import { createAgent, createSession } from '@funny/harness';
import { createFakeRuntime } from '@funny/harness/testing';

const runtime = createFakeRuntime();
const agent = createAgent({ instructions: 'Echo test prompts.' });
const session = createSession({ agent, runtime, cwd: process.cwd() });

console.log(await session.prompt('hello'));
```

## Publication status

The API is experimental while product integrations settle. The package name is
currently `@funny/harness`; `@funny/agent-runtime` remains an open naming option
before public npm publication.
