import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  createAgent,
  createToolRegistry,
  defineTool,
  defineWorkflow,
  runWorkflow,
  type HarnessWorkflowContext,
} from '../index.js';
import { createFakeRuntime } from '../testing.js';

interface TestCtx extends HarnessWorkflowContext {
  value?: number;
  agentOutput?: string;
}

describe('workflow harness', () => {
  test('runs tool-backed and agent-backed workflow steps', async () => {
    const runtime = createFakeRuntime();
    const tool = defineTool({
      name: 'double',
      description: 'Double a number.',
      inputSchema: z.object({ value: z.number() }),
      handler: ({ value }) => value * 2,
    });
    const progress: string[] = [];
    const workflow = defineWorkflow<TestCtx>({
      name: 'test-workflow',
      steps: [
        {
          name: 'tool-step',
          execute: async (ctx) => ({
            ...ctx,
            value: (await ctx.tools.invoke('double', { value: 2 })) as number,
          }),
        },
        {
          name: 'agent-step',
          execute: async (ctx) => {
            const session = ctx.createSession(createAgent({ instructions: 'Echo.' }));
            const result = await session.prompt(`value:${ctx.value}`);
            return { ...ctx, agentOutput: result.output };
          },
        },
      ],
    });

    const result = await runWorkflow(workflow, {
      cwd: '/repo',
      runtime,
      tools: createToolRegistry([tool]),
      progress: {
        onStepProgress: (stepId, data) => progress.push(`${stepId}:${data.status}`),
        onPipelineEvent: (event) => progress.push(`pipeline:${event}`),
      },
    });

    expect(result.outcome).toBe('completed');
    expect(result.ctx.value).toBe(4);
    expect(result.ctx.agentOutput).toBe('fake:value:4');
    expect(progress).toContain('tool-step:running');
    expect(progress).toContain('agent-step:completed');
    expect(progress).toContain('pipeline:completed');
  });

  test('propagates pre-aborted cancellation to pipeline', async () => {
    const controller = new AbortController();
    controller.abort();
    const workflow = defineWorkflow<TestCtx>({
      name: 'cancelled',
      steps: [
        {
          name: 'never',
          execute: (ctx) => ({ ...ctx, value: 1 }),
        },
      ],
    });

    const result = await runWorkflow(workflow, {
      cwd: '/repo',
      runtime: createFakeRuntime(),
      signal: controller.signal,
    });

    expect(result.outcome).toBe('cancelled');
  });
});
