import type { FileDiffSummary } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import { collectSessionChanges } from '@/hooks/use-thread-changed-files';

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
    const changed = [diff('src/a.ts'), diff('src/b.ts')];

    const result = collectSessionChanges(messages, changed);

    expect([...result.keys()]).toEqual(['u1', 'u2']);
    expect(result.get('u1')!.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(result.get('u2')!.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  test('a file touched in two sessions appears in both', () => {
    const messages = [
      userMsg('u1'),
      editMsg('a1', '/repo/src/shared.ts'),
      userMsg('u2'),
      editMsg('a2', '/repo/src/shared.ts'),
    ];
    const changed = [diff('src/shared.ts', 10, 2)];

    const result = collectSessionChanges(messages, changed);

    expect(result.get('u1')!.map((f) => f.path)).toEqual(['src/shared.ts']);
    expect(result.get('u2')!.map((f) => f.path)).toEqual(['src/shared.ts']);
  });

  test('parses stringified tool input and NotebookEdit paths', () => {
    const messages = [
      userMsg('u1'),
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't1', name: 'Write', input: JSON.stringify({ file_path: '/repo/x.md' }) },
          { id: 't2', name: 'NotebookEdit', input: { notebook_path: '/repo/nb.ipynb' } },
        ],
      },
    ];
    const changed = [diff('x.md'), diff('nb.ipynb')];

    const result = collectSessionChanges(messages, changed);

    expect(
      result
        .get('u1')!
        .map((f) => f.path)
        .sort(),
    ).toEqual(['nb.ipynb', 'x.md']);
  });

  test('still lists a touched file missing from the diff (committed/reverted), stat-less', () => {
    const messages = [userMsg('u1'), editMsg('a1', '/repo/committed.ts')];
    // committed.ts is no longer dirty → not in the diff summary
    const changed = [diff('other.ts')];

    const result = collectSessionChanges(messages, changed, '/repo');

    // The file still appears (derived from the persisted tool call), relativized,
    // but carries no +/- stats since it's not in the working-tree diff.
    const files = result.get('u1')!;
    expect(files.map((f) => f.path)).toEqual(['committed.ts']);
    expect(files[0].additions).toBeUndefined();
    expect(files[0].deletions).toBeUndefined();
  });

  test('prefers the working-tree diff entry (with stats) over a synthesized one', () => {
    const messages = [userMsg('u1'), editMsg('a1', '/repo/src/a.ts')];
    const changed = [diff('src/a.ts', 7, 3)];

    const files = collectSessionChanges(messages, changed, '/repo').get('u1')!;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'src/a.ts', additions: 7, deletions: 3 });
  });

  test('lists files derived purely from tool calls even with no diff data (post-refresh)', () => {
    const messages = [userMsg('u1'), editMsg('a1', '/repo/src/a.ts', '/repo/src/b.ts')];
    // changedFiles empty → diff hasn't loaded yet, but the session list still shows.
    const result = collectSessionChanges(messages, [], '/repo');
    expect(result.get('u1')!.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('returns an empty map when no session touched any file', () => {
    const messages = [userMsg('u1'), { id: 'a1', role: 'assistant', content: 'hi', toolCalls: [] }];
    expect(collectSessionChanges(messages, []).size).toBe(0);
  });
});
