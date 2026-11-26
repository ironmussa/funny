import { describe, expect, test } from 'bun:test';

import { mapTimelineNode } from '../../routes/github/issue-timeline.js';

const actor = { login: 'argenisleon', avatarUrl: 'https://a/1' };
const pr = {
  kind: 'PullRequest',
  number: 559,
  title: 'chore(lint): clear findings',
  url: 'https://github.com/O/R/pull/559',
  state: 'MERGED',
  repository: { nameWithOwner: 'O/R' },
};

describe('mapTimelineNode', () => {
  test('maps a comment with its reactions', () => {
    const item = mapTimelineNode({
      kind: 'IssueComment',
      databaseId: 42,
      author: actor,
      authorAssociation: 'MEMBER',
      body: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/o/r/issues/7#issuecomment-42',
      reactionGroups: [
        { content: 'THUMBS_UP', reactors: { totalCount: 2 } },
        { content: 'HEART', reactors: { totalCount: 1 } },
      ],
    });
    expect(item).toMatchObject({
      type: 'comment',
      comment: { id: 42, author: 'argenisleon', reactions: { total: 3, plus1: 2, heart: 1 } },
    });
  });

  test('maps a label event', () => {
    expect(
      mapTimelineNode({
        kind: 'LabeledEvent',
        id: 'L1',
        createdAt: '2026-01-01T00:00:00Z',
        actor,
        label: { name: 'ready-for-agent', color: '0e8a16' },
      }),
    ).toEqual({
      type: 'labeled',
      id: 'L1',
      created_at: '2026-01-01T00:00:00Z',
      actor: { login: 'argenisleon', avatar_url: 'https://a/1' },
      label: { name: 'ready-for-agent', color: '0e8a16' },
    });
  });

  test('maps a mention from a pull request, repository lower-cased', () => {
    expect(
      mapTimelineNode({
        kind: 'CrossReferencedEvent',
        id: 'X1',
        createdAt: '2026-01-01T00:00:00Z',
        actor,
        willCloseTarget: true,
        source: pr,
      }),
    ).toMatchObject({
      type: 'cross-referenced',
      willClose: true,
      source: { kind: 'pr', number: 559, state: 'merged', repo: 'o/r' },
    });
  });

  test('keeps the pull request that closed the issue', () => {
    expect(
      mapTimelineNode({
        kind: 'ClosedEvent',
        id: 'C1',
        createdAt: '2026-01-01T00:00:00Z',
        actor,
        stateReason: 'COMPLETED',
        closer: pr,
      }),
    ).toMatchObject({
      type: 'closed',
      stateReason: 'completed',
      closer: { kind: 'pr', ref: { number: 559 } },
    });
  });

  test('keeps the commit that closed the issue', () => {
    expect(
      mapTimelineNode({
        kind: 'ClosedEvent',
        id: 'C2',
        createdAt: '2026-01-01T00:00:00Z',
        actor: null,
        stateReason: null,
        closer: {
          kind: 'Commit',
          oid: 'abc123',
          url: 'https://github.com/o/r/commit/abc123',
        },
      }),
    ).toMatchObject({
      type: 'closed',
      actor: null,
      stateReason: null,
      closer: { kind: 'commit', sha: 'abc123' },
    });
  });

  test('drops a mention whose source it cannot show', () => {
    expect(
      mapTimelineNode({ kind: 'CrossReferencedEvent', id: 'X2', actor, source: null }),
    ).toBeNull();
    expect(mapTimelineNode({ kind: 'PinnedEvent', id: 'P1' })).toBeNull();
  });
});
