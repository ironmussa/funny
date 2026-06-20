import { describe, expect, test } from 'bun:test';

import { funnyProjectConfigSchema } from '../funny-config-schema.ts';

describe('funnyProjectConfigSchema', () => {
  test('accepts known .funny.json fields and preserves unknown fields', () => {
    const parsed = funnyProjectConfigSchema.safeParse({
      envFiles: ['.env'],
      portGroups: [{ name: 'web', basePort: 3000, envVars: ['PORT'] }],
      postCreate: ['bun install'],
      processes: [{ name: 'dev', command: 'bun run dev' }],
      automations: [{ name: 'daily', prompt: 'check status', schedule: '0 9 * * *' }],
      pluginField: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.pluginField).toBe(true);
  });

  test('rejects malformed known fields', () => {
    expect(
      funnyProjectConfigSchema.safeParse({
        portGroups: [{ name: '', basePort: 3000, envVars: ['PORT'] }],
      }).success,
    ).toBe(false);
  });
});
