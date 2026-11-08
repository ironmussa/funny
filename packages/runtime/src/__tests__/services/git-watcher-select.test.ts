import { describe, expect, test } from 'vitest';

import { selectChangedThreads } from '../../services/git-watcher-service.js';

type Meta = Parameters<typeof selectChangedThreads>[0][number][1];

function meta(fingerprint?: string): Meta {
  return { userId: 'u1', worktreePath: null, fingerprint };
}

describe('selectChangedThreads', () => {
  test('selects only threads whose fingerprint moved and stores the new ones', async () => {
    const a = meta('fa');
    const b = meta('fb');
    const fingerprints: Record<string, string> = { a: 'fa', b: 'fb2' };

    const changed = await selectChangedThreads(
      [
        ['a', a],
        ['b', b],
      ],
      async (id) => fingerprints[id],
    );

    expect(changed.map(([id]) => id)).toEqual(['b']);
    expect(b.fingerprint).toBe('fb2');
  });

  test('selects a thread seen for the first time', async () => {
    const changed = await selectChangedThreads([['a', meta()]], async () => 'fa');
    expect(changed).toHaveLength(1);
  });

  test('selects a thread whose fingerprint cannot be computed, every time', async () => {
    const a = meta('fa');
    expect(await selectChangedThreads([['a', a]], async () => null)).toHaveLength(1);
    expect(a.fingerprint).toBeUndefined();
    expect(await selectChangedThreads([['a', a]], async () => null)).toHaveLength(1);
  });

  test('a second pass with no changes selects nothing', async () => {
    const entries: Array<[string, Meta]> = [
      ['a', meta()],
      ['b', meta()],
    ];
    await selectChangedThreads(entries, async (id) => `f-${id}`);
    expect(await selectChangedThreads(entries, async (id) => `f-${id}`)).toEqual([]);
  });
});
