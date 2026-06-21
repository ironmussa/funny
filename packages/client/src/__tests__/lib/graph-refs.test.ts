import { describe, expect, it } from 'vitest';

import type { GraphRefDTO } from '@/lib/api/git';
import {
  foldGraphRefs,
  graphNodeForkedFromRefLabels,
  graphNodeParentLabels,
  graphNodeParentRefLabels,
  graphNodeRefLabel,
} from '@/lib/graph-refs';

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

describe('graphNodeRefLabel', () => {
  it('prefers the visible local branch label for a synced branch', () => {
    expect(
      graphNodeRefLabel([
        { kind: 'local', name: 'main', isCurrent: true, syncedRemote: 'origin/main' },
      ]),
    ).toBe('main');
  });

  it('uses remote refs directly and falls back to local branch refs', () => {
    expect(graphNodeRefLabel([{ kind: 'remote', name: 'origin/feature', isCurrent: false }])).toBe(
      'origin/feature',
    );
    expect(graphNodeRefLabel([{ kind: 'local', name: 'feature', isCurrent: false }])).toBe(
      'feature',
    );
  });

  it('does not show detached HEAD as an origin branch', () => {
    expect(graphNodeRefLabel([{ kind: 'local', name: 'HEAD', isCurrent: false }])).toBeNull();
  });
});

describe('graphNodeForkedFromRefLabels', () => {
  it('labels a branch tip with the branch it forked from', () => {
    const labels = graphNodeForkedFromRefLabels([
      {
        hash: 'feature-tip',
        refs: [local('feat/cortes-editor')],
        headBranch: 'feat/cortes-editor',
        parentHashes: ['feature-parent'],
      },
      {
        hash: 'feature-parent',
        refs: [],
        headBranch: 'feat/cortes-editor',
        parentHashes: ['master-tip'],
      },
      {
        hash: 'master-tip',
        refs: [local('master'), remote('origin/master')],
        headBranch: 'feat/cortes-editor',
        parentHashes: ['older'],
      },
      {
        hash: 'older',
        refs: [],
        headBranch: 'feat/cortes-editor',
        parentHashes: [],
      },
    ]);

    expect(labels.get('feature-tip')).toBe('master');
  });

  it('does not treat the same branch on an ancestor as the fork origin', () => {
    const labels = graphNodeForkedFromRefLabels([
      {
        hash: 'feature-tip',
        refs: [local('feature')],
        headBranch: 'feature',
        parentHashes: ['feature-ancestor'],
      },
      {
        hash: 'feature-ancestor',
        refs: [remote('origin/feature')],
        headBranch: 'feature',
        parentHashes: ['master-tip'],
      },
      {
        hash: 'master-tip',
        refs: [local('master')],
        headBranch: 'feature',
        parentHashes: [],
      },
    ]);

    expect(labels.get('feature-tip')).toBe('master');
  });
});

describe('graphNodeParentLabels', () => {
  it('uses the direct parent hash and ref label when the parent is loaded', () => {
    const labels = graphNodeParentLabels([
      {
        hash: 'feature-tip',
        shortHash: 'feat123',
        refs: [local('feat/cortes-editor')],
        headBranch: 'feat/cortes-editor',
        parentHashes: ['master-tip'],
      },
      {
        hash: 'master-tip',
        shortHash: 'mast123',
        refs: [local('master'), remote('origin/master')],
        headBranch: 'feat/cortes-editor',
        parentHashes: [],
      },
    ]);

    expect(labels.get('feature-tip')).toEqual({ commit: 'mast123', branchLabels: ['master'] });
  });

  it('uses branch context when the direct parent has no ref of its own', () => {
    const labels = graphNodeParentLabels([
      {
        hash: 'master-tip',
        shortHash: 'mast123',
        refs: [local('master')],
        headBranch: 'master',
        parentHashes: ['middle'],
      },
      {
        hash: 'feature-tip',
        shortHash: 'feat123',
        refs: [local('feature')],
        headBranch: 'feature',
        parentHashes: ['middle'],
      },
      {
        hash: 'middle',
        shortHash: 'mid1234',
        refs: [],
        headBranch: 'feature',
        parentHashes: ['older'],
      },
      {
        hash: 'older',
        shortHash: 'old1234',
        refs: [],
        headBranch: 'feature',
        parentHashes: [],
      },
    ]);

    expect(labels.get('feature-tip')).toEqual({
      commit: 'mid1234',
      branchLabels: ['master', 'feature'],
    });
  });

  it('falls back to the parent hash when the parent is outside the loaded window', () => {
    const labels = graphNodeParentLabels([
      {
        hash: 'feature-tip',
        shortHash: 'feat123',
        refs: [local('feat/cortes-editor')],
        headBranch: 'feat/cortes-editor',
        parentHashes: ['abcdef1234567890'],
      },
    ]);

    expect(labels.get('feature-tip')).toEqual({ commit: 'abcdef1', branchLabels: [] });
  });
});

describe('graphNodeParentRefLabels', () => {
  it('labels a rebased copy node with the source commit branch', () => {
    const labels = graphNodeParentRefLabels(
      [
        {
          sourceHash: 'old-commit',
          sourceShortHash: 'old1234',
          targetHash: 'new-commit',
          event: { branch: 'video-integration', onto: 'main' },
        },
      ],
      [
        {
          hash: 'old-commit',
          refs: [remote('origin/video-integration')],
          headBranch: null,
        },
        {
          hash: 'new-commit',
          refs: [local('feature-copy')],
          headBranch: null,
        },
      ],
    );

    expect(labels.get('new-commit')).toBe('origin/video-integration');
  });

  it('falls back to the rebase branch when the source commit has no refs', () => {
    const labels = graphNodeParentRefLabels(
      [
        {
          sourceHash: 'old-commit',
          sourceShortHash: 'old1234',
          targetHash: 'new-commit',
          event: { branch: 'video-integration', onto: 'main' },
        },
      ],
      [
        { hash: 'old-commit', refs: [], headBranch: null },
        { hash: 'new-commit', refs: [], headBranch: null },
      ],
    );

    expect(labels.get('new-commit')).toBe('video-integration');
  });
});
