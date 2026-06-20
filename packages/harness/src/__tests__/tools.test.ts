import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { createToolRegistry, defineTool } from '../index.js';

describe('tool registry', () => {
  test('validates input before invoking handler', async () => {
    let called = false;
    const tool = defineTool({
      name: 'sum',
      description: 'Add two numbers.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      handler: ({ a, b }) => {
        called = true;
        return a + b;
      },
    });
    const registry = createToolRegistry([tool]);

    await expect(registry.invoke('sum', { a: '1', b: 2 })).rejects.toMatchObject({
      code: 'tool_validation_failed',
    });
    expect(called).toBe(false);
    await expect(registry.invoke('sum', { a: 1, b: 2 })).resolves.toBe(3);
  });

  test('rejects duplicate tool names', () => {
    const first = defineTool({
      name: 'lookup',
      description: 'Lookup.',
      inputSchema: z.object({ id: z.string() }),
      handler: ({ id }) => id,
    });
    const second = defineTool({
      name: 'lookup',
      description: 'Lookup again.',
      inputSchema: z.object({ id: z.string() }),
      handler: ({ id }) => id,
    });

    expect(() => createToolRegistry([first, second])).toThrow(/already registered/);
  });
});
