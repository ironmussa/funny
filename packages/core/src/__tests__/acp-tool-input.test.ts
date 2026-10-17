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

describe('buildACPToolInput — per-tool canonical fields', () => {
  test('file path priority: raw alias > locations > diff > content > title', () => {
    expect(
      buildACPToolInput('Read', {
        title: 'Reading /t.ts',
        rawInput: { path: '/alias.ts', filePath: '/other.ts' },
        locations: [{ path: '/loc.ts' }],
      }).file_path,
    ).toBe('/alias.ts');
    expect(
      buildACPToolInput('Read', {
        title: 'Reading /t.ts',
        locations: [{ path: '/loc.ts' }],
        content: [{ type: 'diff', path: 'file:///diff.ts', newText: 'x' }],
      }).file_path,
    ).toBe('/loc.ts');
    expect(
      buildACPToolInput('Read', {
        title: 'Reading /t.ts',
        content: [{ type: 'diff', path: 'file:///diff.ts', newText: 'x' }],
      }).file_path,
    ).toBe('/diff.ts');
    expect(buildACPToolInput('Read', { title: 'Reading /t.ts and more' }).file_path).toBe('/t.ts');
    expect(buildACPToolInput('Read', { title: '~/notes.md' }).file_path).toBe('~/notes.md');
  });

  test('existing file_path is kept untouched', () => {
    const input = buildACPToolInput('Write', {
      title: 'Write',
      rawInput: { file_path: '/keep.ts', path: '/ignored.ts' },
    });
    expect(input.file_path).toBe('/keep.ts');
  });

  test('Edit surfaces diff old/new text; Read does not; explicit values win', () => {
    const content = [{ type: 'diff', path: '/a.ts', oldText: 'old', newText: 'new' }];
    expect(buildACPToolInput('Edit', { title: 'Edit', content })).toMatchObject({
      file_path: '/a.ts',
      old_string: 'old',
      new_string: 'new',
    });
    const read = buildACPToolInput('Read', { title: 'Read', content });
    expect(read.old_string).toBeUndefined();
    expect(read.new_string).toBeUndefined();
    const kept = buildACPToolInput('Edit', {
      title: 'Edit',
      rawInput: { old_string: 'mine' },
      content,
    });
    expect(kept.old_string).toBe('mine');
    expect(kept.new_string).toBe('new');
  });

  test('Bash command falls back through cmd / shell_command / script / title', () => {
    const cmd = (rawInput: unknown, title = 't') =>
      buildACPToolInput('Bash', { title, rawInput }).command;
    expect(cmd({ cmd: 'a', script: 'c' })).toBe('a');
    expect(cmd({ shell_command: 'b' })).toBe('b');
    expect(cmd({ script: 'c' })).toBe('c');
    expect(cmd(undefined, 'ls -la')).toBe('ls -la');
    expect(cmd({ command: 'keep' })).toBe('keep');
  });

  test('Glob pattern from raw glob, title keyword, title token, then title', () => {
    const pat = (title: string, rawInput?: unknown) =>
      buildACPToolInput('Glob', { title, rawInput }).pattern;
    expect(pat('x', { glob: '*.md' })).toBe('*.md');
    expect(pat('Files matching src/**')).toBe('src/**');
    expect(pat('list *.ts now')).toBe('*.ts');
    expect(pat('list all')).toBe('list all');
  });

  test('Grep pattern parses title, else query / search / title', () => {
    const fromTitle = buildACPToolInput('Grep', { title: "Search for 'TODO' in src/" });
    expect(fromTitle).toMatchObject({ pattern: 'TODO', path: 'src/' });
    const noPath = buildACPToolInput('Grep', { title: 'search for foo' });
    expect(noPath.pattern).toBe('foo');
    expect(noPath.path).toBeUndefined();
    const pat = (rawInput?: unknown) =>
      buildACPToolInput('Grep', { title: 'grep', rawInput }).pattern;
    expect(pat({ query: 'q', search: 's' })).toBe('q');
    expect(pat({ search: 's' })).toBe('s');
    expect(pat()).toBe('grep');
  });

  test('WebFetch / WebSearch / Task / Think fill their primary field', () => {
    expect(buildACPToolInput('WebFetch', { title: 'u', rawInput: { href: 'h' } }).url).toBe('h');
    expect(buildACPToolInput('WebFetch', { title: 'https://x' }).url).toBe('https://x');
    expect(buildACPToolInput('WebSearch', { title: 't', rawInput: { search: 's' } }).query).toBe(
      's',
    );
    expect(buildACPToolInput('WebSearch', { title: 'cats' }).query).toBe('cats');
    expect(buildACPToolInput('Task', { title: 'do it' }).description).toBe('do it');
    expect(buildACPToolInput('Think', { title: 'hmm' })).toEqual({
      content: 'hmm',
      description: 'hmm',
    });
    expect(buildACPToolInput('Think', { title: '' })).toEqual({});
  });

  test('TodoWrite without todos keeps the raw input plus description fallback', () => {
    expect(buildACPToolInput('TodoWrite', { title: 'Plan', rawInput: { merge: true } })).toEqual({
      merge: true,
      description: 'Plan',
    });
  });

  test('unknown tool names only get the description fallback', () => {
    expect(buildACPToolInput('Tool', { title: 'x', rawInput: { a: 1 } })).toEqual({
      a: 1,
      description: 'x',
    });
    expect(buildACPToolInput('constructor', { title: 'x' })).toEqual({ description: 'x' });
  });
});
