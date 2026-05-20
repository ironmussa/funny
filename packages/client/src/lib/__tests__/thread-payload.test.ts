import { describe, test, expect } from 'vitest';

import { buildThreadPayload, type BuildInput } from '../thread-payload';

function baseInput(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    projectId: 'proj-1',
    prompt: 'hello',
    opts: { model: 'sonnet', mode: 'autoEdit' },
    defaultThreadMode: 'local',
    toolPermissions: {},
    ...overrides,
  };
}

describe('buildThreadPayload', () => {
  describe('scratch branch', () => {
    test('wins over forceIdle and stage', () => {
      const result = buildThreadPayload(
        baseInput({ isScratch: true, projectId: null, forceIdle: true, stage: 'planning' }),
      );
      expect(result.kind).toBe('scratch');
      if (result.kind !== 'scratch') return;
      expect(result.payload.prompt).toBe('hello');
      expect(result.payload.title).toBe('hello');
      expect(result.payload.model).toBe('sonnet');
      expect(result.payload.permissionMode).toBe('autoEdit');
    });

    test('truncates title at 200 chars', () => {
      const long = 'x'.repeat(500);
      const result = buildThreadPayload(baseInput({ isScratch: true, prompt: long }));
      if (result.kind !== 'scratch') throw new Error('expected scratch');
      expect(result.payload.title?.length).toBe(200);
    });

    test('omits projectId entirely (createScratchThread takes none)', () => {
      const result = buildThreadPayload(baseInput({ isScratch: true, projectId: null }));
      if (result.kind !== 'scratch') throw new Error('expected scratch');
      expect('projectId' in result.payload).toBe(false);
    });
  });

  describe('idle branch', () => {
    test('triggered by forceIdle', () => {
      const result = buildThreadPayload(baseInput({ forceIdle: true }));
      expect(result.kind).toBe('idle');
    });

    test('triggered by opts.sendToBacklog', () => {
      const result = buildThreadPayload(
        baseInput({ opts: { model: 's', mode: 'autoEdit', sendToBacklog: true } }),
      );
      expect(result.kind).toBe('idle');
    });

    test('includes stage when provided (Kanban planning column)', () => {
      const result = buildThreadPayload(baseInput({ forceIdle: true, stage: 'planning' }));
      if (result.kind !== 'idle') throw new Error('expected idle');
      expect(result.payload.stage).toBe('planning');
    });

    test('omits stage when undefined (server defaults to backlog)', () => {
      const result = buildThreadPayload(baseInput({ forceIdle: true }));
      if (result.kind !== 'idle') throw new Error('expected idle');
      expect('stage' in result.payload).toBe(false);
    });

    test('omits designId when undefined — never sends null', () => {
      const result = buildThreadPayload(baseInput({ forceIdle: true, designId: undefined }));
      if (result.kind !== 'idle') throw new Error('expected idle');
      expect('designId' in result.payload).toBe(false);
    });

    test('includes designId when provided', () => {
      const result = buildThreadPayload(baseInput({ forceIdle: true, designId: 'd-1' }));
      if (result.kind !== 'idle') throw new Error('expected idle');
      expect(result.payload.designId).toBe('d-1');
    });

    test('uses opts.threadMode over defaultThreadMode', () => {
      const result = buildThreadPayload(
        baseInput({
          forceIdle: true,
          opts: { model: 's', mode: 'autoEdit', threadMode: 'worktree' },
          defaultThreadMode: 'local',
        }),
      );
      if (result.kind !== 'idle') throw new Error('expected idle');
      expect(result.payload.mode).toBe('worktree');
    });

    test('falls back to defaultThreadMode when opts.threadMode is unset', () => {
      const result = buildThreadPayload(
        baseInput({ forceIdle: true, defaultThreadMode: 'worktree' }),
      );
      if (result.kind !== 'idle') throw new Error('expected idle');
      expect(result.payload.mode).toBe('worktree');
    });

    test('throws when projectId is null and not scratch', () => {
      expect(() => buildThreadPayload(baseInput({ projectId: null, forceIdle: true }))).toThrow(
        /projectId is required/,
      );
    });
  });

  describe('normal branch', () => {
    test('used when nothing forces scratch or idle', () => {
      const result = buildThreadPayload(baseInput());
      expect(result.kind).toBe('normal');
    });

    test('derives allowedTools/disallowedTools from toolPermissions', () => {
      const result = buildThreadPayload(
        baseInput({
          toolPermissions: { Bash: 'allow', WebFetch: 'deny', Read: 'ask' },
        }),
      );
      if (result.kind !== 'normal') throw new Error('expected normal');
      expect(result.payload.allowedTools).toEqual(['Bash']);
      expect(result.payload.disallowedTools).toEqual(['WebFetch']);
    });

    test('forwards fileReferences and symbolReferences', () => {
      const result = buildThreadPayload(
        baseInput({
          opts: {
            model: 's',
            mode: 'autoEdit',
            fileReferences: [{ path: 'src/foo.ts' }],
            symbolReferences: [{ path: 'src/foo.ts', name: 'bar', kind: 'function', line: 12 }],
          },
        }),
      );
      if (result.kind !== 'normal') throw new Error('expected normal');
      expect(result.payload.fileReferences).toEqual([{ path: 'src/foo.ts' }]);
      expect(result.payload.symbolReferences?.[0]?.name).toBe('bar');
    });

    test('forwards provider, effort, runtime, agentTemplateId, templateVariables', () => {
      const result = buildThreadPayload(
        baseInput({
          opts: {
            model: 's',
            mode: 'autoEdit',
            provider: 'codex',
            effort: 'high',
            runtime: 'remote',
            agentTemplateId: 'tpl-1',
            templateVariables: { FOO: 'bar' },
          },
        }),
      );
      if (result.kind !== 'normal') throw new Error('expected normal');
      expect(result.payload.provider).toBe('codex');
      expect(result.payload.effort).toBe('high');
      expect(result.payload.runtime).toBe('remote');
      expect(result.payload.agentTemplateId).toBe('tpl-1');
      expect(result.payload.templateVariables).toEqual({ FOO: 'bar' });
    });

    test('omits designId when undefined', () => {
      const result = buildThreadPayload(baseInput());
      if (result.kind !== 'normal') throw new Error('expected normal');
      expect('designId' in result.payload).toBe(false);
    });
  });
});
