import type { ToolPermission } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import { buildThreadPayload, type BuildInput } from '@/lib/thread-payload';
import { ALL_STANDARD_TOOLS } from '@/stores/settings-store';

const defaultPermissions: Record<string, ToolPermission> = Object.fromEntries(
  ALL_STANDARD_TOOLS.map((tool) => [tool, 'allow' as ToolPermission]),
);

function baseInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    projectId: 'p-1',
    prompt: 'Fix the login bug',
    opts: {
      model: 'sonnet',
      mode: 'autoEdit',
      provider: 'anthropic',
      threadMode: 'local',
    },
    defaultThreadMode: 'local',
    toolPermissions: defaultPermissions,
    ...overrides,
  };
}

describe('buildThreadPayload', () => {
  test('builds scratch payload when isScratch is true', () => {
    const result = buildThreadPayload(
      baseInput({
        isScratch: true,
        projectId: null,
        prompt: 'Try a regex',
        opts: { model: 'haiku', mode: 'plan', provider: 'anthropic' },
      }),
    );

    expect(result.kind).toBe('scratch');
    expect(result.payload).toEqual({
      prompt: 'Try a regex',
      title: 'Try a regex',
      provider: 'anthropic',
      model: 'haiku',
      permissionMode: 'plan',
      images: undefined,
    });
  });

  test('truncates title to 200 characters', () => {
    const longPrompt = 'x'.repeat(250);
    const result = buildThreadPayload(baseInput({ prompt: longPrompt, isScratch: true }));

    expect(result.kind).toBe('scratch');
    expect(result.payload.title).toHaveLength(200);
    expect(result.payload.title).toBe('x'.repeat(200));
  });

  test('throws when projectId is missing for non-scratch threads', () => {
    expect(() => buildThreadPayload(baseInput({ projectId: null }))).toThrow(
      'projectId is required for idle/normal threads',
    );
  });

  test('builds idle payload when forceIdle is set', () => {
    const result = buildThreadPayload(
      baseInput({
        forceIdle: true,
        stage: 'planning',
        designId: 'design-1',
        opts: {
          model: 'sonnet',
          mode: 'plan',
          threadMode: 'worktree',
          baseBranch: 'main',
        },
      }),
    );

    expect(result.kind).toBe('idle');
    expect(result.payload).toMatchObject({
      projectId: 'p-1',
      title: 'Fix the login bug',
      mode: 'worktree',
      baseBranch: 'main',
      prompt: 'Fix the login bug',
      stage: 'planning',
      designId: 'design-1',
    });
  });

  test('builds idle payload when sendToBacklog is true', () => {
    const result = buildThreadPayload(
      baseInput({
        opts: {
          model: 'sonnet',
          mode: 'plan',
          sendToBacklog: true,
        },
      }),
    );

    expect(result.kind).toBe('idle');
    expect(result.payload).toMatchObject({ projectId: 'p-1', prompt: 'Fix the login bug' });
    expect(result.payload).not.toHaveProperty('stage');
  });

  test('builds normal payload with derived tool lists', () => {
    const permissions: Record<string, ToolPermission> = {
      Read: 'allow',
      Bash: 'deny',
      Edit: 'ask',
    };

    const result = buildThreadPayload(
      baseInput({
        toolPermissions: permissions,
        designId: 'd-99',
        opts: {
          model: 'opus',
          mode: 'confirmEdit',
          provider: 'anthropic',
          effort: 'high',
          runtime: 'remote',
          threadMode: 'worktree',
          baseBranch: 'develop',
          fileReferences: [{ path: 'src/a.ts', type: 'file' }],
          symbolReferences: [{ path: 'src/a.ts', name: 'foo', kind: 'function', line: 10 }],
          agentTemplateId: 'tpl-1',
          templateVariables: { name: 'world' },
        },
      }),
    );

    expect(result.kind).toBe('normal');
    expect(result.payload).toMatchObject({
      projectId: 'p-1',
      mode: 'worktree',
      runtime: 'remote',
      provider: 'anthropic',
      model: 'opus',
      permissionMode: 'confirmEdit',
      effort: 'high',
      baseBranch: 'develop',
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      designId: 'd-99',
      agentTemplateId: 'tpl-1',
      templateVariables: { name: 'world' },
    });
  });

  test('uses defaultThreadMode when opts.threadMode is omitted', () => {
    const result = buildThreadPayload(
      baseInput({
        defaultThreadMode: 'worktree',
        opts: { model: 'sonnet', mode: 'autoEdit' },
      }),
    );

    expect(result.kind).toBe('normal');
    expect(result.payload).toMatchObject({ mode: 'worktree' });
  });
});
