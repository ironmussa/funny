import type {
  PRReviewThread,
  PRThreadComment,
  PRConversation,
  PRIssueComment,
  PRReview,
} from '@funny/shared';
import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { isBoolean } from '../../lib/value-guards.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { parseJsonBody } from '../../validation/request.js';
import {
  fetchIssueComments,
  githubApiFetch,
  githubCommentPath,
  githubErrorWithBody,
  githubGraphQL,
  githubPrFor,
  githubRepoFor,
  mapIssueComment,
  mapReactions,
  sendGithubJson,
} from './helpers.js';
import { positiveIntParam, prCommentKindParam } from './query.js';

export const prThreadRoutes = new Hono<HonoEnv>();

const prCommentBodySchema = z
  .object({
    projectId: z.string().optional(),
    prNumber: z.number().optional(),
    body: z.string().optional(),
  })
  .passthrough();

const prReviewReplyBodySchema = z
  .object({
    projectId: z.string().optional(),
    prNumber: z.number().optional(),
    commentId: z.number().optional(),
    body: z.string().optional(),
  })
  .passthrough();

const prThreadResolveBodySchema = z
  .object({
    projectId: z.string().optional(),
    threadNodeId: z.string().optional(),
    resolve: z.boolean().optional(),
  })
  .passthrough();

const prReactionContentSchema = z.enum([
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes',
]);

const prCommentKindSchema = z.enum(['issue', 'review']);

const prReactionBodySchema = z
  .object({
    projectId: z.string().optional(),
    kind: prCommentKindSchema.optional(),
    commentId: z.number().optional(),
    content: prReactionContentSchema.optional(),
  })
  .passthrough();

const prPatchCommentBodySchema = z
  .object({
    projectId: z.string().optional(),
    kind: prCommentKindSchema.optional(),
    commentId: z.number().optional(),
    body: z.string().optional(),
  })
  .passthrough();

// ── GET /pr-threads — PR review comment threads ──────

prThreadRoutes.get('/pr-threads', async (c) => {
  const access = await githubPrFor(c);
  if (access instanceof Response) return access;
  const { owner, repo, token, prNumber } = access;

  try {
    // Fetch all review comments (paginated, up to 100)
    const res = await githubApiFetch(
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100&sort=created&direction=asc`,
      token,
    );

    if (!res.ok) {
      return c.json({ error: `GitHub API error: ${res.status}` }, 502);
    }

    const rawComments: any[] = await res.json();

    // Group comments into threads: root comments (no in_reply_to_id) start threads,
    // replies reference their root via in_reply_to_id
    const threadMap = new Map<number, { root: any; replies: any[] }>();
    const replyToRoot = new Map<number, number>();

    for (const comment of rawComments) {
      if (!comment.in_reply_to_id) {
        // Root comment — starts a thread
        threadMap.set(comment.id, { root: comment, replies: [] });
      }
    }

    for (const comment of rawComments) {
      if (comment.in_reply_to_id) {
        const rootId = comment.in_reply_to_id;
        const thread = threadMap.get(rootId);
        if (thread) {
          thread.replies.push(comment);
          replyToRoot.set(comment.id, rootId);
        }
      }
    }

    // Enrich with GraphQL to get review-thread node_ids and resolution status.
    // Map keyed by the databaseId of the thread's first comment.
    const threadMetaByRootId = new Map<number, { node_id: string; is_resolved: boolean }>();
    try {
      const gql = await githubGraphQL<{
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                isOutdated: boolean;
                comments: { nodes: Array<{ databaseId: number }> };
              }>;
            };
          };
        };
      }>(
        `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  isOutdated
                  comments(first: 1) { nodes { databaseId } }
                }
              }
            }
          }
        }`,
        { owner, repo, number: prNumber },
        token,
      );
      for (const t of gql.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
        const rootDb = t.comments?.nodes?.[0]?.databaseId;
        if (rootDb) threadMetaByRootId.set(rootDb, { node_id: t.id, is_resolved: t.isResolved });
      }
    } catch (gqlErr: any) {
      log.warn('pr-threads GraphQL enrichment failed', {
        namespace: 'github-routes',
        error: gqlErr.message,
      });
    }

    const threads: PRReviewThread[] = [];
    for (const [_id, { root, replies }] of threadMap) {
      const allComments = [root, ...replies];
      const mappedComments: PRThreadComment[] = allComments.map((cm: any) => ({
        id: cm.id,
        author: cm.user?.login ?? '',
        author_avatar_url: cm.user?.avatar_url ?? '',
        body: cm.body ?? '',
        created_at: cm.created_at ?? '',
        updated_at: cm.updated_at ?? '',
        author_association: cm.author_association ?? '',
      }));

      const meta = threadMetaByRootId.get(root.id);
      threads.push({
        id: root.id,
        node_id: meta?.node_id ?? null,
        path: root.path ?? '',
        line: root.line ?? null,
        original_line: root.original_line ?? null,
        side: root.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        start_line: root.start_line ?? null,
        is_resolved: meta?.is_resolved ?? false,
        is_outdated: root.position === null,
        comments: mappedComments,
      });
    }

    return c.json({ threads });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── GET /pr-conversation — PR body comments + reviews ───────

prThreadRoutes.get('/pr-conversation', async (c) => {
  const ctx = await githubPrFor(c);
  if (ctx instanceof Response) return ctx;
  const { owner, repo, token, prNumber } = ctx;

  try {
    const [commentsRes, reviewsRes] = await Promise.all([
      fetchIssueComments(ctx, prNumber),
      githubApiFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`, token),
    ]);

    if (!commentsRes.ok) return c.json({ error: `GitHub API error: ${commentsRes.status}` }, 502);
    if (!reviewsRes.ok) return c.json({ error: `GitHub API error: ${reviewsRes.status}` }, 502);

    const rawComments: any[] = await commentsRes.json();
    // SAFETY: GitHub's list-reviews response for a 2xx answer (checked above)
    // is an array of reviews; each field is read optionally below.
    const rawReviews = (await reviewsRes.json()) as any[];

    const comments: PRIssueComment[] = rawComments.map(mapIssueComment);

    const reviews: PRReview[] = rawReviews
      .filter((rv) => rv.state !== 'PENDING')
      .map((rv) => ({
        id: rv.id,
        author: rv.user?.login ?? '',
        author_avatar_url: rv.user?.avatar_url ?? '',
        body: rv.body ?? '',
        // SAFETY: GitHub's review states are APPROVED, CHANGES_REQUESTED,
        // COMMENTED, DISMISSED and PENDING, the PRReview states; an absent
        // state is shown as a comment.
        state: (rv.state ?? 'COMMENTED') as PRReview['state'],
        submitted_at: rv.submitted_at ?? '',
        html_url: rv.html_url ?? '',
      }));

    const conversation: PRConversation = { comments, reviews };
    return c.json(conversation);
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /pr-comment — create issue (conversation) comment ───

prThreadRoutes.post('/pr-comment', async (c) => {
  const parsed = await parseJsonBody(c, prCommentBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const raw = parsed.value;
  if (!raw.projectId || !raw.prNumber || !raw.body) {
    return c.json({ error: 'projectId, prNumber and body are required' }, 400);
  }

  const ctx = await githubRepoFor(c, raw.projectId);
  if (ctx instanceof Response) return ctx;
  const { owner, repo, token } = ctx;

  try {
    const res = await sendGithubJson(
      `/repos/${owner}/${repo}/issues/${raw.prNumber}/comments`,
      token,
      'POST',
      { body: raw.body },
    );
    if (!res.ok) return githubErrorWithBody(c, res);
    const comment: PRIssueComment = mapIssueComment(await res.json());
    return c.json(comment);
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /pr-review-reply — reply in a review thread ────────

prThreadRoutes.post('/pr-review-reply', async (c) => {
  const parsed = await parseJsonBody(c, prReviewReplyBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const raw = parsed.value;
  if (!raw.projectId || !raw.prNumber || !raw.commentId || !raw.body) {
    return c.json({ error: 'projectId, prNumber, commentId and body are required' }, 400);
  }

  const ctx = await githubRepoFor(c, raw.projectId);
  if (ctx instanceof Response) return ctx;
  const { owner, repo, token } = ctx;

  try {
    const res = await sendGithubJson(
      `/repos/${owner}/${repo}/pulls/${raw.prNumber}/comments/${raw.commentId}/replies`,
      token,
      'POST',
      { body: raw.body },
    );
    if (!res.ok) return githubErrorWithBody(c, res);
    const cm = await res.json();
    const comment: PRThreadComment = {
      id: cm.id,
      author: cm.user?.login ?? '',
      author_avatar_url: cm.user?.avatar_url ?? '',
      body: cm.body ?? '',
      created_at: cm.created_at ?? '',
      updated_at: cm.updated_at ?? '',
      author_association: cm.author_association ?? '',
    };
    return c.json(comment);
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /pr-thread-resolve — resolve/unresolve review thread ───

prThreadRoutes.post('/pr-thread-resolve', async (c) => {
  const parsed = await parseJsonBody(c, prThreadResolveBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const raw = parsed.value;
  if (!raw.projectId || !raw.threadNodeId || !isBoolean(raw.resolve)) {
    return c.json({ error: 'projectId, threadNodeId and resolve are required' }, 400);
  }

  const ctx = await githubRepoFor(c, raw.projectId);
  if (ctx instanceof Response) return ctx;
  const { token } = ctx;

  const mutation = raw.resolve
    ? `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`
    : `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`;

  try {
    const data = await githubGraphQL<{
      resolveReviewThread?: { thread: { id: string; isResolved: boolean } };
      unresolveReviewThread?: { thread: { id: string; isResolved: boolean } };
    }>(mutation, { id: raw.threadNodeId }, token);
    const thread = data.resolveReviewThread?.thread ?? data.unresolveReviewThread?.thread ?? null;
    return c.json({
      node_id: thread?.id ?? raw.threadNodeId,
      is_resolved: thread?.isResolved ?? raw.resolve,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /pr-reaction — add reaction to a comment ───────────

prThreadRoutes.post('/pr-reaction', async (c) => {
  const parsed = await parseJsonBody(c, prReactionBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const raw = parsed.value;
  if (!raw.projectId || !raw.kind || !raw.commentId || !raw.content) {
    return c.json({ error: 'projectId, kind, commentId and content are required' }, 400);
  }

  const ctx = await githubRepoFor(c, raw.projectId);
  if (ctx instanceof Response) return ctx;
  const path = `${githubCommentPath(ctx, raw.kind, raw.commentId)}/reactions`;

  try {
    const res = await sendGithubJson(path, ctx.token, 'POST', { content: raw.content });
    if (!res.ok) return githubErrorWithBody(c, res);
    // SAFETY: GitHub's create-reaction response for a 2xx answer (checked
    // above) is the reaction, with its numeric `id` and `content`.
    const reaction = (await res.json()) as { id: number; content: string };
    return c.json({ id: reaction.id, content: reaction.content });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── PATCH /pr-comment — edit a comment ──────────────────────

prThreadRoutes.patch('/pr-comment', async (c) => {
  const parsed = await parseJsonBody(c, prPatchCommentBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const raw = parsed.value;
  if (!raw.projectId || !raw.kind || !raw.commentId || !raw.body) {
    return c.json({ error: 'projectId, kind, commentId and body are required' }, 400);
  }

  const ctx = await githubRepoFor(c, raw.projectId);
  if (ctx instanceof Response) return ctx;
  const path = githubCommentPath(ctx, raw.kind, raw.commentId);

  try {
    const res = await sendGithubJson(path, ctx.token, 'PATCH', { body: raw.body });
    if (!res.ok) return githubErrorWithBody(c, res);
    const cm = await res.json();
    return c.json({
      id: cm.id,
      body: cm.body ?? '',
      updated_at: cm.updated_at ?? '',
      reactions: mapReactions(cm.reactions),
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── DELETE /pr-comment — delete a comment ───────────────────

prThreadRoutes.delete('/pr-comment', async (c) => {
  const projectId = c.req.query('projectId');
  const kind = prCommentKindParam(c);
  const commentId = positiveIntParam(c, 'commentId');
  if (!projectId || !kind || !commentId) {
    return c.json({ error: 'projectId, kind and commentId are required' }, 400);
  }

  const ctx = await githubRepoFor(c, projectId);
  if (ctx instanceof Response) return ctx;

  try {
    const res = await githubApiFetch(githubCommentPath(ctx, kind, commentId), ctx.token, {
      method: 'DELETE',
    });
    if (!res.ok) return githubErrorWithBody(c, res);
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});
