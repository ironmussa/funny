import type { ToolPermission } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import { buildSendMessagePayload } from '@/lib/send-message-payload';

describe('buildSendMessagePayload', () => {
  const toolPermissions: Record<string, ToolPermission> = {
    Read: 'allow',
    Bash: 'deny',
    Edit: 'ask',
  };

  test('maps PromptInput fields to API payload shape', () => {
    const payload = buildSendMessagePayload(
      {
        provider: 'anthropic',
        model: 'sonnet',
        mode: 'autoEdit',
        effort: 'high',
        baseBranch: 'main',
        fileReferences: [{ path: 'src/a.ts' }],
        symbolReferences: [{ path: 'src/a.ts', name: 'foo', kind: 'function', line: 1 }],
      },
      toolPermissions,
    );

    expect(payload).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      effort: 'high',
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      fileReferences: [{ path: 'src/a.ts' }],
      symbolReferences: [{ path: 'src/a.ts', name: 'foo', kind: 'function', line: 1 }],
      baseBranch: 'main',
    });
  });

  test('omits effort when includeEffort is false', () => {
    const payload = buildSendMessagePayload(
      { model: 'sonnet', mode: 'plan', effort: 'high' },
      toolPermissions,
      { includeEffort: false },
    );

    expect(payload).not.toHaveProperty('effort');
    expect(payload.permissionMode).toBe('plan');
  });

  test('converts empty strings to undefined for optional fields', () => {
    const payload = buildSendMessagePayload(
      { provider: '', model: '', mode: '', effort: '' },
      toolPermissions,
    );

    expect(payload.provider).toBeUndefined();
    expect(payload.model).toBeUndefined();
    expect(payload.permissionMode).toBeUndefined();
    expect(payload.effort).toBeUndefined();
  });
});
