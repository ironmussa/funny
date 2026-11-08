import { describe, test, expect } from 'bun:test';

import { collectSessionChanges, latestSessionChanges } from '../session-changed-files.js';
import type { FileDiffSummary } from '../types/git.js';

function diff(path: string, additions = 1, deletions = 0): FileDiffSummary {
  return { path, status: 'modified', staged: false, additions, deletions };
}

function userMsg(id: string) {
  return { id, role: 'user', content: 'do it', toolCalls: [] };
}

function editMsg(id: string, ...absPaths: string[]) {
  return {
    id,
    role: 'assistant',
    content: '',
    toolCalls: absPaths.map((p, i) => ({
      id: `${id}-tc${i}`,
      name: 'Edit',
      input: { file_path: p },
    })),
  };
}

describe('collectSessionChanges', () => {
  test('buckets changed files by the session whose tool calls touched them', () => {
    const messages = [
      userMsg('u1'),
      editMsg('a1', '/repo/src/a.ts'),
      userMsg('u2'),
      editMsg('a2', '/repo/src/b.ts'),
    ];
    const result = collectSessionChanges(messages, [diff('src/a.ts'), diff('src/b.ts')]);
    expect([...result.keys()]).toEqual(['u1', 'u2']);
    expect(result.get('u1')!.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(result.get('u2')!.map((f) => f.path)).toEqual(['src/b.ts']);
  });
});

describe('latestSessionChanges', () => {
  test('returns only the last session and keys it by that user-message id', () => {
    const messages = [
      userMsg('u1'),
      editMsg('a1', '/repo/src/a.ts'),
      userMsg('u2'),
      editMsg('a2', '/repo/src/b.ts'),
    ];
    const result = latestSessionChanges(
      messages,
      [diff('src/a.ts', 1, 0), diff('src/b.ts', 7, 3)],
      '/repo',
    );
    expect(result).not.toBeNull();
    expect(result!.userMessageId).toBe('u2');
    expect(result!.files).toHaveLength(1);
    expect(result!.files[0]).toMatchObject({ path: 'src/b.ts', additions: 7, deletions: 3 });
  });

  test('freezes +/- stats from the supplied diff (snapshot, not live)', () => {
    const messages = [userMsg('u1'), editMsg('a1', '/repo/x.ts')];
    const result = latestSessionChanges(messages, [diff('x.ts', 22, 6)], '/repo');
    expect(result!.files[0]).toMatchObject({ path: 'x.ts', additions: 22, deletions: 6 });
  });

  test('still lists a touched file missing from the diff, stat-less', () => {
    const messages = [userMsg('u1'), editMsg('a1', '/repo/committed.ts')];
    const result = latestSessionChanges(messages, [], '/repo');
    expect(result!.files.map((f) => f.path)).toEqual(['committed.ts']);
    expect(result!.files[0].additions).toBeUndefined();
  });

  test('returns null when the latest session touched no files', () => {
    const messages = [userMsg('u1'), { id: 'a1', role: 'assistant', content: 'hi', toolCalls: [] }];
    expect(latestSessionChanges(messages, [])).toBeNull();
  });

  test('returns null when there are no messages at all', () => {
    expect(latestSessionChanges([], [])).toBeNull();
  });
});

function bashMsg(id: string) {
  return {
    id,
    role: 'assistant',
    content: '',
    toolCalls: [{ id: `${id}-tc0`, name: 'Bash', input: { command: 'python3 fix.py' } }],
  };
}

describe('latestSessionChanges with a session-start baseline', () => {
  test('includes files a shell command changed since the session started', () => {
    const messages = [userMsg('u1'), bashMsg('a1')];
    const result = latestSessionChanges(
      messages,
      [diff('src/already-dirty.ts', 2, 0), diff('src/by-script.ts', 5, 1)],
      '/repo',
      [diff('src/already-dirty.ts', 2, 0)],
    );
    expect(result?.userMessageId).toBe('u1');
    expect(result?.files.map((f) => f.path)).toEqual(['src/by-script.ts']);
  });

  test('counts an already-dirty file whose stats changed during the session', () => {
    const messages = [userMsg('u1'), bashMsg('a1')];
    const result = latestSessionChanges(messages, [diff('src/a.ts', 9, 0)], '/repo', [
      diff('src/a.ts', 2, 0),
    ]);
    expect(result?.files).toEqual([diff('src/a.ts', 9, 0)]);
  });

  test('ignores working-tree changes when the session ran no shell command', () => {
    const messages = [userMsg('u1'), editMsg('a1', '/repo/src/a.ts')];
    const result = latestSessionChanges(
      messages,
      [diff('src/a.ts', 1, 0), diff('src/someone-else.ts', 3, 0)],
      '/repo',
      [],
    );
    expect(result?.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  test('does not list a file twice when both a tool call and the diff report it', () => {
    const messages = [userMsg('u1'), editMsg('a1', '/repo/src/a.ts'), bashMsg('a2')];
    const result = latestSessionChanges(messages, [diff('src/a.ts', 4, 0)], '/repo', []);
    expect(result?.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });
});
