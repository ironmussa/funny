import { describe, expect, test } from 'vitest';

import {
  buildACPToolInput,
  buildTodoWriteInputFromRaw,
  extractACPToolOutput,
  hasRenderableTodoInput,
  inferACPToolName,
} from '../agents/acp-tool-input.js';

describe('extractACPToolOutput', () => {
  test('unwraps Cursor read_file `{ content: string }` rawOutput', () => {
    const out = extractACPToolOutput({ content: 'hello world' }, undefined, 'Read File');
    expect(out).toBe('hello world');
  });

  test('unwraps `{ text }` and `{ output }` and `{ stdout }` rawOutput shapes', () => {
    expect(extractACPToolOutput({ text: 'a' }, undefined, '')).toBe('a');
    expect(extractACPToolOutput({ output: 'b' }, undefined, '')).toBe('b');
    expect(extractACPToolOutput({ stdout: 'c' }, undefined, '')).toBe('c');
  });

  test('falls back to JSON.stringify for non-text-bearing objects', () => {
    const out = extractACPToolOutput({ exitCode: 0, files: 3 }, undefined, '');
    expect(out).toBe(JSON.stringify({ exitCode: 0, files: 3 }));
  });

  test('extracts text from embedded resource content blocks', () => {
    const out = extractACPToolOutput(
      undefined,
      [
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///repo/foo.ts', text: 'export const x = 1;' },
          },
        },
      ],
      '',
    );
    expect(out).toBe('export const x = 1;');
  });
});

describe('buildACPToolInput — Read with Cursor-style data', () => {
  test('pulls file_path from `target_file` rawInput alias', () => {
    const input = buildACPToolInput('Read', {
      kind: 'read',
      title: 'Read File',
      rawInput: { target_file: '/repo/src/app.ts' },
    });
    expect(input.file_path).toBe('/repo/src/app.ts');
  });

  test('falls back to resource_link uri in content blocks', () => {
    const input = buildACPToolInput('Read', {
      kind: 'read',
      title: 'Read File',
      content: [
        {
          type: 'content',
          content: { type: 'resource_link', uri: 'file:///repo/src/app.ts' },
        },
      ],
    });
    expect(input.file_path).toBe('/repo/src/app.ts');
  });

  test('falls back to embedded resource uri in content blocks', () => {
    const input = buildACPToolInput('Read', {
      kind: 'read',
      title: 'Read File',
      content: [
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///repo/src/app.ts', text: '...' },
          },
        },
      ],
    });
    expect(input.file_path).toBe('/repo/src/app.ts');
  });

  test('leaves file_path unset when nothing identifies the file', () => {
    const input = buildACPToolInput('Read', {
      kind: 'read',
      title: 'Read File',
    });
    expect(input.file_path).toBeUndefined();
    expect(input.description).toBe('Read File');
  });
});

describe('Cursor updateTodos → TodoWrite', () => {
  test('inferACPToolName maps raw `_toolName: updateTodos` to TodoWrite', () => {
    expect(
      inferACPToolName(undefined, 'Update TODOs', undefined, {
        _toolName: 'updateTodos',
        description: 'Update TODOs',
      }),
    ).toBe('TodoWrite');
  });

  test('buildACPToolInput normalizes Cursor todos payload', () => {
    const input = buildACPToolInput('TodoWrite', {
      title: 'Update TODOs',
      rawInput: {
        _toolName: 'updateTodos',
        todos: [
          { id: '1', content: 'Fix CI', status: 'in_progress' },
          { id: '2', content: 'Add tests', status: 'pending' },
        ],
        merge: true,
      },
    });
    expect(input).toEqual({
      todos: [
        { content: 'Fix CI', status: 'in_progress' },
        { content: 'Add tests', status: 'pending' },
      ],
    });
    expect(hasRenderableTodoInput(input)).toBe(true);
  });

  test('buildTodoWriteInputFromRaw reads accepted outcome todos', () => {
    const built = buildTodoWriteInputFromRaw({
      outcome: {
        outcome: 'accepted',
        todos: [{ id: '1', content: 'Ship it', status: 'completed' }],
      },
    });
    expect(built).toEqual({ todos: [{ content: 'Ship it', status: 'completed' }] });
  });
});
