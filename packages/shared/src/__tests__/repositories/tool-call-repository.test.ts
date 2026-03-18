import { describe, test, expect, beforeEach } from 'bun:test';

import { createToolCallRepository } from '../../repositories/tool-call-repository.js';
import {
  createTestDb,
  seedProject,
  seedThread,
  seedMessage,
  seedToolCall,
} from '../helpers/test-db.js';

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
