import { describe, test, expect, beforeEach } from 'bun:test';

import { createToolCallRepository } from '../../repositories/tool-call-repository.js';
import { createTestDb, seedProject, seedThread, seedMessage } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createToolCallRepository>;

beforeEach(() => {
  deps = createTestDb();
  repo = createToolCallRepository(deps);
  seedProject(deps.db);
  seedThread(deps.db);
  seedMessage(deps.db);
});

describe('insertToolCall', () => {
  test('returns a generated ID', async () => {
    const id = await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{}' });
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  test('generates unique IDs for each call', async () => {
    const id1 = await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{}' });
    const id2 = await repo.insertToolCall({ messageId: 'm1', name: 'Write', input: '{}' });
    expect(id1).not.toBe(id2);
  });

  test('stores tool call with all fields', async () => {
    const id = await repo.insertToolCall({
      messageId: 'm1',
      name: 'Bash',
      input: '{"command":"ls"}',
      author: 'agent-1',
    });
    const tc = await repo.getToolCall(id);
    expect(tc).toBeDefined();
    expect(tc!.name).toBe('Bash');
    expect(tc!.input).toBe('{"command":"ls"}');
    expect(tc!.author).toBe('agent-1');
  });
});

describe('insertToolCall with parentToolCallId', () => {
  test('stores parentToolCallId when provided', async () => {
    const parentId = await repo.insertToolCall({ messageId: 'm1', name: 'Task', input: '{}' });
    const childId = await repo.insertToolCall({
      messageId: 'm1',
      name: 'Read',
      input: '{"file":"a.ts"}',
      parentToolCallId: parentId,
    });
    const child = await repo.getToolCall(childId);
    expect(child).toBeDefined();
    expect(child!.parentToolCallId).toBe(parentId);
  });

  test('parentToolCallId defaults to null when not provided', async () => {
    const id = await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{}' });
    const tc = await repo.getToolCall(id);
    expect(tc!.parentToolCallId).toBeNull();
  });

  test('parentToolCallId is null when explicitly set to null', async () => {
    const id = await repo.insertToolCall({
      messageId: 'm1',
      name: 'Read',
      input: '{}',
      parentToolCallId: null,
    });
    const tc = await repo.getToolCall(id);
    expect(tc!.parentToolCallId).toBeNull();
  });
});

describe('updateToolCallOutput', () => {
  test('updates the output field', async () => {
    const id = await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{}' });
    await repo.updateToolCallOutput(id, 'file contents here');
    const tc = await repo.getToolCall(id);
    expect(tc!.output).toBe('file contents here');
  });

  test('overwrites previous output', async () => {
    const id = await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{}' });
    await repo.updateToolCallOutput(id, 'first');
    await repo.updateToolCallOutput(id, 'second');
    const tc = await repo.getToolCall(id);
    expect(tc!.output).toBe('second');
  });
});

describe('findToolCall', () => {
  test('finds existing tool call by messageId + name + input', async () => {
    const id = await repo.insertToolCall({
      messageId: 'm1',
      name: 'Read',
      input: '{"file":"a.ts"}',
    });
    const found = await repo.findToolCall('m1', 'Read', '{"file":"a.ts"}');
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
  });

  test('returns undefined when no match', async () => {
    await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{"file":"a.ts"}' });
    const found = await repo.findToolCall('m1', 'Write', '{"file":"a.ts"}');
    expect(found).toBeUndefined();
  });

  test('distinguishes different inputs for same name', async () => {
    await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{"file":"a.ts"}' });
    const id2 = await repo.insertToolCall({
      messageId: 'm1',
      name: 'Read',
      input: '{"file":"b.ts"}',
    });
    const found = await repo.findToolCall('m1', 'Read', '{"file":"b.ts"}');
    expect(found!.id).toBe(id2);
  });
});

describe('getToolCall', () => {
  test('returns tool call by ID', async () => {
    const id = await repo.insertToolCall({ messageId: 'm1', name: 'Bash', input: '{}' });
    const tc = await repo.getToolCall(id);
    expect(tc).toBeDefined();
    expect(tc!.id).toBe(id);
  });

  test('returns undefined for non-existent ID', async () => {
    const tc = await repo.getToolCall('nonexistent');
    expect(tc).toBeUndefined();
  });
});

describe('findLastUnansweredInteractiveToolCall', () => {
  test('finds AskUserQuestion with null output', async () => {
    const id = await repo.insertToolCall({
      messageId: 'm1',
      name: 'AskUserQuestion',
      input: '{"question":"Pick one"}',
    });
    const found = await repo.findLastUnansweredInteractiveToolCall('t1');
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
    expect(found!.name).toBe('AskUserQuestion');
  });

  test('finds ExitPlanMode with null output', async () => {
    const id = await repo.insertToolCall({
      messageId: 'm1',
      name: 'ExitPlanMode',
      input: '{}',
    });
    const found = await repo.findLastUnansweredInteractiveToolCall('t1');
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
  });

  test('ignores tool calls with output already set', async () => {
    const id = await repo.insertToolCall({
      messageId: 'm1',
      name: 'AskUserQuestion',
      input: '{}',
    });
    await repo.updateToolCallOutput(id, 'user answered');
    const found = await repo.findLastUnansweredInteractiveToolCall('t1');
    expect(found).toBeUndefined();
  });

  test('ignores non-interactive tool calls', async () => {
    await repo.insertToolCall({ messageId: 'm1', name: 'Read', input: '{}' });
    const found = await repo.findLastUnansweredInteractiveToolCall('t1');
    expect(found).toBeUndefined();
  });

  test('returns undefined when thread has no tool calls', async () => {
    const found = await repo.findLastUnansweredInteractiveToolCall('t1');
    expect(found).toBeUndefined();
  });
});

describe('getTouchedFiles', () => {
  const insert = (name: string, input: unknown) =>
    repo.insertToolCall({
      messageId: 'm1',
      name,
      input: typeof input === 'string' ? input : JSON.stringify(input),
    });

  test('returns sorted unique paths of file-modifying tools only', async () => {
    await insert('Write', { file_path: '/repo/b.ts', content: 'x' });
    await insert('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' });
    await insert('Edit', { file_path: '/repo/a.ts', old_string: 'b', new_string: 'c' });
    await insert('NotebookEdit', { notebook_path: '/repo/n.ipynb', new_source: '' });
    await insert('Read', { file_path: '/repo/ignored.ts' });
    expect(await repo.getTouchedFiles('t1')).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/n.ipynb']);
  });

  test('finds a path that comes after a large file body', async () => {
    await insert('Write', { content: 'y'.repeat(50_000), file_path: '/repo/late.ts' });
    expect(await repo.getTouchedFiles('t1')).toEqual(['/repo/late.ts']);
  });

  test('ignores a path-like key nested inside an earlier value', async () => {
    await insert('Write', { meta: { file_path: '/wrong.ts' }, file_path: '/repo/right.ts' });
    await insert('Write', { content: '"file_path": "/also-wrong.ts"', file_path: '/repo/x.ts' });
    expect(await repo.getTouchedFiles('t1')).toEqual(['/repo/right.ts', '/repo/x.ts']);
  });

  test('decodes escaped characters in the path', async () => {
    await insert('Write', { file_path: '/repo/quote"d\\name ñ.ts', content: 'z'.repeat(5_000) });
    expect(await repo.getTouchedFiles('t1')).toEqual(['/repo/quote"d\\name ñ.ts']);
  });

  test('prefers file_path over notebook_path like the full parse', async () => {
    await insert('NotebookEdit', { notebook_path: '/repo/n.ipynb', file_path: '/repo/f.ts' });
    expect(await repo.getTouchedFiles('t1')).toEqual(['/repo/f.ts']);
  });

  test('skips invalid JSON and inputs without a path', async () => {
    await insert('Write', '{not json');
    await insert('Edit', { old_string: 'a', new_string: 'b' });
    await insert('Write', { file_path: '', content: 'x' });
    expect(await repo.getTouchedFiles('t1')).toEqual([]);
  });

  test('reads only a bounded prefix when the path leads the input', async () => {
    await insert('Write', { file_path: '/repo/big.ts', content: 'q'.repeat(200_000) });
    const statements: string[] = [];
    const tracked = createToolCallRepository({
      ...deps,
      dbAll: ((query: { toSQL(): { sql: string } }) => {
        statements.push(query.toSQL().sql);
        return deps.dbAll(query as never);
      }) as typeof deps.dbAll,
    });
    expect(await tracked.getTouchedFiles('t1')).toEqual(['/repo/big.ts']);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('substr(');
  });
});
