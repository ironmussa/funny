/**
 * An issue's timeline as GitHub's issue page shows it: the comments and the
 * events between them (labels, mentions from other issues and pull requests,
 * closing and reopening, renames, assignees, referencing commits).
 *
 * GraphQL, not REST: the REST timeline does not say which pull request closed
 * the issue (`ClosedEvent.closer`), which is what "closed this in #559" needs.
 */

import type {
  IssueTimelineActor,
  IssueTimelineItem,
  IssueTimelineRef,
  PRIssueComment,
  PRReactionSummary,
} from '@funny/shared';

import { isNumber } from '../../lib/value-guards.js';
import { githubGraphQL } from './helpers.js';

const ITEM_TYPES = [
  'ISSUE_COMMENT',
  'LABELED_EVENT',
  'UNLABELED_EVENT',
  'CROSS_REFERENCED_EVENT',
  'CLOSED_EVENT',
  'REOPENED_EVENT',
  'RENAMED_TITLE_EVENT',
  'ASSIGNED_EVENT',
  'UNASSIGNED_EVENT',
  'REFERENCED_EVENT',
].join(', ');

const ACTOR = 'actor { login avatarUrl }';
const REF_FIELDS = 'number title url state repository { nameWithOwner }';

const ISSUE_TIMELINE_QUERY = `
  query IssueTimeline($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        timelineItems(first: 100, after: $after, itemTypes: [${ITEM_TYPES}]) {
          pageInfo { hasNextPage endCursor }
          nodes {
            kind: __typename
            ... on IssueComment {
              databaseId
              author { login avatarUrl }
              authorAssociation
              body
              createdAt
              updatedAt
              url
              reactionGroups { content reactors { totalCount } }
            }
            ... on LabeledEvent { id createdAt ${ACTOR} label { name color } }
            ... on UnlabeledEvent { id createdAt ${ACTOR} label { name color } }
            ... on CrossReferencedEvent {
              id createdAt ${ACTOR} willCloseTarget
              source {
                kind: __typename
                ... on PullRequest { ${REF_FIELDS} }
                ... on Issue { ${REF_FIELDS} }
              }
            }
            ... on ClosedEvent {
              id createdAt ${ACTOR} stateReason
              closer {
                kind: __typename
                ... on PullRequest { ${REF_FIELDS} }
                ... on Commit { oid url }
              }
            }
            ... on ReopenedEvent { id createdAt ${ACTOR} }
            ... on RenamedTitleEvent { id createdAt ${ACTOR} previousTitle currentTitle }
            ... on AssignedEvent { id createdAt ${ACTOR} assignee { ... on Actor { login avatarUrl } } }
            ... on UnassignedEvent { id createdAt ${ACTOR} assignee { ... on Actor { login avatarUrl } } }
            ... on ReferencedEvent { id createdAt ${ACTOR} commit { oid url messageHeadline } }
          }
        }
      }
    }
  }
`;

/** At most this many pages of 100 items: a very long issue shows its first 500. */
const MAX_PAGES = 5;

interface GqlActor {
  login: string;
  avatarUrl: string;
}

interface GqlRef {
  kind: string;
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  repository?: { nameWithOwner: string };
}

/** One timeline node; which fields are set depends on `__typename`. */
export interface TimelineNode {
  kind: string;
  id?: string;
  createdAt?: string;
  actor?: GqlActor | null;
  // IssueComment
  databaseId?: number;
  author?: GqlActor | null;
  authorAssociation?: string;
  body?: string;
  updatedAt?: string;
  url?: string;
  reactionGroups?: Array<{ content: string; reactors: { totalCount: number } }>;
  // Labeled / Unlabeled
  label?: { name: string; color: string };
  // CrossReferenced
  willCloseTarget?: boolean;
  source?: GqlRef | null;
  // Closed
  stateReason?: string | null;
  closer?: (GqlRef & { oid?: string }) | null;
  // RenamedTitle
  previousTitle?: string;
  currentTitle?: string;
  // Assigned / Unassigned
  assignee?: Partial<GqlActor> | null;
  // Referenced
  commit?: { oid: string; url: string; messageHeadline: string } | null;
}

interface TimelinePage {
  repository: {
    issue: {
      timelineItems: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: TimelineNode[];
      };
    } | null;
  } | null;
}

function toActor(actor: Partial<GqlActor> | null | undefined): IssueTimelineActor | null {
  if (!actor?.login) return null;
  return { login: actor.login, avatar_url: actor.avatarUrl ?? '' };
}

function toRefState(state: string | undefined): IssueTimelineRef['state'] {
  if (state === 'MERGED') return 'merged';
  if (state === 'OPEN') return 'open';
  return 'closed';
}

const str = (v: string | null | undefined): string => v ?? '';

function isRefKind(kind: string | undefined): kind is 'PullRequest' | 'Issue' {
  return kind === 'PullRequest' || kind === 'Issue';
}

function toRef(node: GqlRef | null | undefined): IssueTimelineRef | null {
  if (!node || !isRefKind(node.kind) || !isNumber(node.number) || !node.url) return null;
  return {
    kind: node.kind === 'PullRequest' ? 'pr' : 'issue',
    number: node.number,
    title: str(node.title),
    url: node.url,
    state: toRefState(node.state),
    repo: str(node.repository?.nameWithOwner).toLowerCase(),
  };
}

const REACTION_KEYS = {
  THUMBS_UP: 'plus1',
  THUMBS_DOWN: 'minus1',
  LAUGH: 'laugh',
  HOORAY: 'hooray',
  CONFUSED: 'confused',
  HEART: 'heart',
  ROCKET: 'rocket',
  EYES: 'eyes',
} as const satisfies Record<string, keyof Omit<PRReactionSummary, 'total'>>;

function toReactions(groups: TimelineNode['reactionGroups']): PRReactionSummary {
  const summary: PRReactionSummary = {
    total: 0,
    plus1: 0,
    minus1: 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  };
  const counts = new Map((groups ?? []).map((g) => [g.content, g.reactors.totalCount]));
  for (const [content, key] of Object.entries(REACTION_KEYS)) {
    const count = counts.get(content) ?? 0;
    summary[key] = count;
    summary.total += count;
  }
  return summary;
}

function toComment(node: TimelineNode): PRIssueComment {
  return {
    id: node.databaseId ?? 0,
    author: node.author?.login ?? '',
    author_avatar_url: node.author?.avatarUrl ?? '',
    author_association: node.authorAssociation ?? '',
    body: node.body ?? '',
    created_at: node.createdAt ?? '',
    updated_at: node.updatedAt ?? '',
    html_url: node.url ?? '',
    reactions: toReactions(node.reactionGroups),
  };
}

function toStateReason(reason: string | null | undefined) {
  if (reason === 'COMPLETED') return 'completed' as const;
  if (reason === 'NOT_PLANNED') return 'not_planned' as const;
  if (reason === 'DUPLICATE') return 'duplicate' as const;
  return null;
}

interface TimelineBase {
  id: string;
  created_at: string;
  actor: IssueTimelineActor | null;
}

function toCloser(closer: TimelineNode['closer']) {
  const ref = toRef(closer);
  if (ref) return { kind: 'pr' as const, ref };
  if (closer?.kind === 'Commit' && closer.oid && closer.url) {
    return { kind: 'commit' as const, sha: closer.oid, url: closer.url };
  }
  return null;
}

type TimelineMapper = (node: TimelineNode, base: TimelineBase) => IssueTimelineItem | null;

const TIMELINE_MAPPERS = new Map<string, TimelineMapper>([
  [
    'LabeledEvent',
    (node, base) =>
      node.label
        ? { ...base, type: 'labeled', label: { name: node.label.name, color: node.label.color } }
        : null,
  ],
  [
    'UnlabeledEvent',
    (node, base) =>
      node.label
        ? { ...base, type: 'unlabeled', label: { name: node.label.name, color: node.label.color } }
        : null,
  ],
  [
    'CrossReferencedEvent',
    (node, base) => {
      const source = toRef(node.source);
      return source
        ? { ...base, type: 'cross-referenced', source, willClose: !!node.willCloseTarget }
        : null;
    },
  ],
  [
    'ClosedEvent',
    (node, base) => ({
      ...base,
      type: 'closed',
      stateReason: toStateReason(node.stateReason),
      closer: toCloser(node.closer),
    }),
  ],
  ['ReopenedEvent', (_node, base) => ({ ...base, type: 'reopened' })],
  [
    'RenamedTitleEvent',
    (node, base) => ({
      ...base,
      type: 'renamed',
      from: str(node.previousTitle),
      to: str(node.currentTitle),
    }),
  ],
  [
    'AssignedEvent',
    (node, base) => ({
      ...base,
      type: 'assigned',
      assignee: toActor(node.assignee),
    }),
  ],
  [
    'UnassignedEvent',
    (node, base) => ({
      ...base,
      type: 'unassigned',
      assignee: toActor(node.assignee),
    }),
  ],
  [
    'ReferencedEvent',
    (node, base) =>
      node.commit
        ? {
            ...base,
            type: 'commit-referenced',
            commit: {
              sha: node.commit.oid,
              url: node.commit.url,
              message: node.commit.messageHeadline,
            },
          }
        : null,
  ],
]);

/** Maps one GraphQL timeline node; `null` for a node funny does not show. */
export function mapTimelineNode(node: TimelineNode): IssueTimelineItem | null {
  if (node.kind === 'IssueComment') return { type: 'comment', comment: toComment(node) };
  const mapper = node.kind ? TIMELINE_MAPPERS.get(node.kind) : undefined;
  if (!mapper) return null;
  return mapper(node, {
    id: str(node.id),
    created_at: str(node.createdAt),
    actor: toActor(node.actor),
  });
}

/**
 * The issue's timeline, oldest first; `null` when the repository has no
 * issue with that number (a pull request number answers `null` too).
 */
export async function fetchIssueTimeline(
  repo: { owner: string; repo: string; token: string },
  issueNumber: number,
): Promise<IssueTimelineItem[] | null> {
  const items: IssueTimelineItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: TimelinePage = await githubGraphQL<TimelinePage>(
      ISSUE_TIMELINE_QUERY,
      { owner: repo.owner, repo: repo.repo, number: issueNumber, after },
      repo.token,
    );
    const timeline = data?.repository?.issue?.timelineItems;
    if (!timeline) return page === 0 ? null : items;
    for (const node of timeline.nodes) {
      const item = mapTimelineNode(node);
      if (item) items.push(item);
    }
    if (!timeline.pageInfo.hasNextPage) break;
    after = timeline.pageInfo.endCursor;
  }
  return items;
}
