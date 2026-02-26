import { describe, test, expect } from 'bun:test';

import {
  createProjectSchema,
  createThreadSchema,
  updateProjectSchema,
  sendMessageSchema,
  threadModeSchema,
  permissionModeSchema,
  stageFilesSchema,
  commitSchema,
  createPRSchema,
  mergeSchema,
  threadStageSchema,
  validate,
} from '../../validation/schemas.js';

// ── Enum schemas ─────────────────────────────────────────────

describe('threadModeSchema', () => {
  test('accepts "local"', () => {
    expect(threadModeSchema.safeParse('local').success).toBe(true);
  });

  test('accepts "worktree"', () => {
    expect(threadModeSchema.safeParse('worktree').success).toBe(true);
  });

  test('rejects invalid value', () => {
    expect(threadModeSchema.safeParse('invalid').success).toBe(false);
  });

  test('rejects empty string', () => {
    expect(threadModeSchema.safeParse('').success).toBe(false);
  });

  test('rejects number', () => {
    expect(threadModeSchema.safeParse(123).success).toBe(false);
  });
});

describe('permissionModeSchema', () => {
  test('accepts "plan"', () => {
    expect(permissionModeSchema.safeParse('plan').success).toBe(true);
  });

  test('accepts "autoEdit"', () => {
    expect(permissionModeSchema.safeParse('autoEdit').success).toBe(true);
  });

  test('accepts "confirmEdit"', () => {
    expect(permissionModeSchema.safeParse('confirmEdit').success).toBe(true);
  });

  test('rejects invalid value', () => {
    expect(permissionModeSchema.safeParse('readOnly').success).toBe(false);
  });
});

describe('threadStageSchema', () => {
  test('accepts "backlog"', () => {
    expect(threadStageSchema.safeParse('backlog').success).toBe(true);
  });

  test('accepts "in_progress"', () => {
    expect(threadStageSchema.safeParse('in_progress').success).toBe(true);
  });

  test('accepts "review"', () => {
    expect(threadStageSchema.safeParse('review').success).toBe(true);
  });

  test('accepts "done"', () => {
    expect(threadStageSchema.safeParse('done').success).toBe(true);
  });

  test('rejects "cancelled"', () => {
    expect(threadStageSchema.safeParse('cancelled').success).toBe(false);
  });
});

// ── createProjectSchema ──────────────────────────────────────

describe('createProjectSchema', () => {
  test('accepts valid project', () => {
    const result = createProjectSchema.safeParse({
      name: 'My Project',
      path: '/home/user/project',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('My Project');
      expect(result.data.path).toBe('/home/user/project');
    }
  });

  test('rejects missing name', () => {
    const result = createProjectSchema.safeParse({ path: '/some/path' });
    expect(result.success).toBe(false);
  });

  test('rejects empty name', () => {
    const result = createProjectSchema.safeParse({ name: '', path: '/some/path' });
    expect(result.success).toBe(false);
  });

  test('rejects missing path', () => {
    const result = createProjectSchema.safeParse({ name: 'Project' });
    expect(result.success).toBe(false);
  });

  test('rejects empty path', () => {
    const result = createProjectSchema.safeParse({ name: 'Project', path: '' });
    expect(result.success).toBe(false);
  });

  test('rejects empty object', () => {
    const result = createProjectSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('strips extra fields', () => {
    const result = createProjectSchema.safeParse({
      name: 'Test',
      path: '/path',
      extra: 'should be stripped',
    });
    expect(result.success).toBe(true);
  });
});

// ── createThreadSchema ───────────────────────────────────────

describe('createThreadSchema', () => {
  const validThread = {
    projectId: 'proj-1',
    mode: 'local' as const,
    prompt: 'Do something',
  };

  test('accepts minimal valid thread', () => {
    const result = createThreadSchema.safeParse(validThread);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe('proj-1');
      expect(result.data.mode).toBe('local');
      expect(result.data.prompt).toBe('Do something');
    }
  });

  test('applies default model to "sonnet"', () => {
    const result = createThreadSchema.safeParse(validThread);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('sonnet');
    }
  });

  test('applies default permissionMode to "autoEdit"', () => {
    const result = createThreadSchema.safeParse(validThread);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissionMode).toBe('autoEdit');
    }
  });

  test('applies default provider to "claude"', () => {
    const result = createThreadSchema.safeParse(validThread);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('claude');
    }
  });

  test('applies default title to empty string', () => {
    const result = createThreadSchema.safeParse(validThread);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('');
    }
  });

  test('accepts all valid fields', () => {
    const result = createThreadSchema.safeParse({
      ...validThread,
      title: 'My thread',
      model: 'opus',
      permissionMode: 'plan',
      baseBranch: 'main',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('opus');
      expect(result.data.permissionMode).toBe('plan');
      expect(result.data.baseBranch).toBe('main');
      expect(result.data.title).toBe('My thread');
    }
  });

  test('rejects missing projectId', () => {
    const result = createThreadSchema.safeParse({ mode: 'local', prompt: 'test' });
    expect(result.success).toBe(false);
  });

  test('rejects missing mode', () => {
    const result = createThreadSchema.safeParse({ projectId: 'p1', prompt: 'test' });
    expect(result.success).toBe(false);
  });

  test('rejects missing prompt', () => {
    const result = createThreadSchema.safeParse({ projectId: 'p1', mode: 'local' });
    expect(result.success).toBe(false);
  });

  test('rejects empty prompt', () => {
    const result = createThreadSchema.safeParse({ ...validThread, prompt: '' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid mode', () => {
    const result = createThreadSchema.safeParse({ ...validThread, mode: 'remote' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid model', () => {
    const result = createThreadSchema.safeParse({ ...validThread, model: 'gpt-4' });
    expect(result.success).toBe(false);
  });

  test('accepts haiku model', () => {
    const result = createThreadSchema.safeParse({ ...validThread, model: 'haiku' });
    expect(result.success).toBe(true);
  });

  test('accepts worktree mode', () => {
    const result = createThreadSchema.safeParse({ ...validThread, mode: 'worktree' });
    expect(result.success).toBe(true);
  });

  test('accepts fileReferences array', () => {
    const result = createThreadSchema.safeParse({
      ...validThread,
      fileReferences: [{ path: 'src/index.ts' }, { path: 'README.md' }],
    });
    expect(result.success).toBe(true);
  });

  test('rejects fileReferences exceeding max (20)', () => {
    const refs = Array.from({ length: 21 }, (_, i) => ({ path: `file${i}.ts` }));
    const result = createThreadSchema.safeParse({
      ...validThread,
      fileReferences: refs,
    });
    expect(result.success).toBe(false);
  });
});

// ── updateProjectSchema ──────────────────────────────────────

describe('updateProjectSchema', () => {
  test('accepts valid name', () => {
    const result = updateProjectSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  test('accepts valid hex color', () => {
    const result = updateProjectSchema.safeParse({ color: '#FF5733' });
    expect(result.success).toBe(true);
  });

  test('accepts lowercase hex color', () => {
    const result = updateProjectSchema.safeParse({ color: '#ff5733' });
    expect(result.success).toBe(true);
  });

  test('accepts null color (to clear)', () => {
    const result = updateProjectSchema.safeParse({ color: null });
    expect(result.success).toBe(true);
  });

  test('rejects invalid hex color (missing #)', () => {
    const result = updateProjectSchema.safeParse({ color: 'FF5733' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid hex color (too short)', () => {
    const result = updateProjectSchema.safeParse({ color: '#FFF' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid hex color (too long)', () => {
    const result = updateProjectSchema.safeParse({ color: '#FF5733AA' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid hex characters', () => {
    const result = updateProjectSchema.safeParse({ color: '#GGGGGG' });
    expect(result.success).toBe(false);
  });

  test('rejects empty name', () => {
    const result = updateProjectSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  test('accepts empty object (all fields optional)', () => {
    const result = updateProjectSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ── sendMessageSchema ────────────────────────────────────────

describe('sendMessageSchema', () => {
  test('accepts valid message', () => {
    const result = sendMessageSchema.safeParse({ content: 'Hello' });
    expect(result.success).toBe(true);
  });

  test('rejects empty content', () => {
    const result = sendMessageSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  test('rejects missing content', () => {
    const result = sendMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('accepts with optional model', () => {
    const result = sendMessageSchema.safeParse({ content: 'test', model: 'opus' });
    expect(result.success).toBe(true);
  });

  test('accepts with optional permissionMode', () => {
    const result = sendMessageSchema.safeParse({ content: 'test', permissionMode: 'plan' });
    expect(result.success).toBe(true);
  });

  test('accepts with optional images array', () => {
    const result = sendMessageSchema.safeParse({
      content: 'test',
      images: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'base64data',
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ── stageFilesSchema ─────────────────────────────────────────

describe('stageFilesSchema', () => {
  test('accepts array with paths', () => {
    const result = stageFilesSchema.safeParse({ paths: ['src/index.ts'] });
    expect(result.success).toBe(true);
  });

  test('accepts multiple paths', () => {
    const result = stageFilesSchema.safeParse({ paths: ['a.ts', 'b.ts', 'c.ts'] });
    expect(result.success).toBe(true);
  });

  test('rejects empty paths array', () => {
    const result = stageFilesSchema.safeParse({ paths: [] });
    expect(result.success).toBe(false);
  });

  test('rejects missing paths', () => {
    const result = stageFilesSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── commitSchema ─────────────────────────────────────────────

describe('commitSchema', () => {
  test('accepts valid message', () => {
    const result = commitSchema.safeParse({ message: 'fix: resolve crash' });
    expect(result.success).toBe(true);
  });

  test('rejects empty message', () => {
    const result = commitSchema.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  test('rejects missing message', () => {
    const result = commitSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── createPRSchema ───────────────────────────────────────────

describe('createPRSchema', () => {
  test('accepts valid PR', () => {
    const result = createPRSchema.safeParse({ title: 'Add feature', body: 'Description here' });
    expect(result.success).toBe(true);
  });

  test('rejects empty title', () => {
    const result = createPRSchema.safeParse({ title: '', body: 'desc' });
    expect(result.success).toBe(false);
  });

  test('accepts empty body', () => {
    const result = createPRSchema.safeParse({ title: 'Title', body: '' });
    expect(result.success).toBe(true);
  });

  test('rejects missing body', () => {
    const result = createPRSchema.safeParse({ title: 'Title' });
    expect(result.success).toBe(false);
  });
});

// ── mergeSchema ──────────────────────────────────────────────

describe('mergeSchema', () => {
  test('accepts empty object (all optional)', () => {
    const result = mergeSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.push).toBe(false);
      expect(result.data.cleanup).toBe(false);
    }
  });

  test('accepts targetBranch', () => {
    const result = mergeSchema.safeParse({ targetBranch: 'main' });
    expect(result.success).toBe(true);
  });

  test('accepts push=true', () => {
    const result = mergeSchema.safeParse({ push: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.push).toBe(true);
    }
  });

  test('accepts cleanup=true', () => {
    const result = mergeSchema.safeParse({ cleanup: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cleanup).toBe(true);
    }
  });
});

// ── validate() helper ────────────────────────────────────────

describe('validate', () => {
  test('returns ok for valid data', () => {
    const result = validate(createProjectSchema, { name: 'Test', path: '/path' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ name: 'Test', path: '/path' });
    }
  });

  test('returns err for invalid data', () => {
    const result = validate(createProjectSchema, { name: '' });
    expect(result.isErr()).toBe(true);
  });

  test('err contains VALIDATION type', () => {
    const result = validate(createProjectSchema, {});
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('VALIDATION');
    }
  });

  test('err contains first issue message', () => {
    const result = validate(commitSchema, { message: '' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('message is required');
    }
  });

  test('returns ok with defaults applied', () => {
    const result = validate(createThreadSchema, {
      projectId: 'p1',
      mode: 'local',
      prompt: 'test',
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.model).toBe('sonnet');
      expect(result.value.permissionMode).toBe('autoEdit');
    }
  });

  test('returns err for completely wrong type', () => {
    const result = validate(createProjectSchema, 'not an object');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('VALIDATION');
    }
  });

  test('returns err for null input', () => {
    const result = validate(createProjectSchema, null);
    expect(result.isErr()).toBe(true);
  });
});
