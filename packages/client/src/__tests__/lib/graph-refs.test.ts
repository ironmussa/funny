import { describe, expect, it } from 'vitest';

import type { GraphRefDTO } from '@/lib/api/git';
import { foldGraphRefs } from '@/lib/graph-refs';

const local = (name: string): GraphRefDTO => ({ name, kind: 'local' });
const remote = (name: string): GraphRefDTO => ({ name, kind: 'remote' });
const tag = (name: string): GraphRefDTO => ({ name, kind: 'tag' });

describe('foldGraphRefs', () => {
  it('collapses a local branch and its in-sync remote into one local entry', () => {
    const folded = foldGraphRefs([local('feat/x'), remote('origin/feat/x')], 'feat/x');
    expect(folded).toHaveLength(1);
    expect(folded[0]).toEqual({
      kind: 'local',
      name: 'feat/x',
      isCurrent: true,
      syncedRemote: 'origin/feat/x',
    });
  });

  it('handles branch names that themselves contain a slash', () => {
    // `feat/cortes-editor` (slashed local) must still pair with `origin/feat/cortes-editor`,
    // not be mistaken for a remote because it contains `/`.
    const folded = foldGraphRefs(
      [local('feat/cortes-editor'), remote('origin/feat/cortes-editor')],
      null,
    );
    expect(folded).toEqual([
      {
        kind: 'local',
        name: 'feat/cortes-editor',
        isCurrent: false,
        syncedRemote: 'origin/feat/cortes-editor',
      },
    ]);
  });

  it('keeps a lone remote (local is ahead, so no pair on this commit) as a remote entry', () => {
    const folded = foldGraphRefs([remote('origin/main')], null);
    expect(folded).toEqual([{ kind: 'remote', name: 'origin/main', isCurrent: false }]);
  });

  it('keeps a lone local branch (no remote on this commit) without a synced marker', () => {
    const folded = foldGraphRefs([local('main')], 'main');
    expect(folded).toEqual([
      { kind: 'local', name: 'main', isCurrent: true, syncedRemote: undefined },
    ]);
  });

  it('passes tags through and preserves overall ref order minus folded remotes', () => {
    const folded = foldGraphRefs(
      [local('main'), tag('v1.0'), remote('origin/main'), remote('upstream/feature')],
      'main',
    );
    expect(folded).toEqual([
      { kind: 'local', name: 'main', isCurrent: true, syncedRemote: 'origin/main' },
      { kind: 'tag', name: 'v1.0', isCurrent: false },
      { kind: 'remote', name: 'upstream/feature', isCurrent: false },
    ]);
  });

  it('marks the detached-HEAD literal as a non-current local chip', () => {
    expect(foldGraphRefs([local('HEAD')], null)).toEqual([
      { kind: 'local', name: 'HEAD', isCurrent: false, syncedRemote: undefined },
    ]);
  });

  it('folds the legacy bare-string wire shape (older runner) by name heuristic', () => {
    // A lagging runner may still send `refs: string[]` with no `kind`. Folding
    // must still work: `origin/master` pairs with `master` (its branch portion
    // is a sibling ref), and `v1.0` is recognized as a tag.
    const folded = foldGraphRefs(['master', 'origin/master', 'v1.0'], 'master');
    expect(folded).toEqual([
      { kind: 'local', name: 'master', isCurrent: true, syncedRemote: 'origin/master' },
      { kind: 'tag', name: 'v1.0', isCurrent: false },
    ]);
  });

  it('drops empty/whitespace ref names so they never render a blank chip', () => {
    expect(foldGraphRefs(['', '  ', local(''), local('main')], 'main')).toEqual([
      { kind: 'local', name: 'main', isCurrent: true, syncedRemote: undefined },
    ]);
  });

  it('keeps a slashed local branch (no sibling) as local on the legacy path', () => {
    // `feat/x` has a `/` but no sibling `x` ref, so it must NOT be mistaken for a
    // remote — it stays a plain local chip.
    expect(foldGraphRefs(['feat/x'], 'feat/x')).toEqual([
      { kind: 'local', name: 'feat/x', isCurrent: true, syncedRemote: undefined },
    ]);
  });
});
