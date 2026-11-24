/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 *
 * The thread reads a factory run's flow resumes with (`factory-flow-runs.ts`):
 * whether a thread finished, whether an interrupted follow-up reached it, and
 * which thread an interrupted launch started.
 */

import { and, asc, desc, eq, gte, like } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { messages, threads } from '../../db/schema.js';

/** Allowance for the runner's clock being behind the server's when matching a launch. */
const LAUNCH_CLOCK_SLACK_MS = 60 * 1000;

const slackBefore = (since: string) =>
  new Date(Date.parse(since) - LAUNCH_CLOCK_SLACK_MS).toISOString();

export async function threadCompletedAt(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ completedAt: threads.completedAt })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row?.completedAt ?? null;
}

/** A user message on the thread since `since`: an interrupted follow-up reached it. */
export async function followedUpSince(threadId: string, since: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.role, 'user'),
        gte(messages.timestamp, slackBefore(since)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The factory thread an interrupted launch started: the enabler's, in the
 * project, with the step's title, created since the launch began. One run per
 * issue is in flight and its steps run one at a time, so the title and the time
 * identify it.
 */
export async function findLaunchedThread(
  scope: { userId: string; projectId: string },
  titlePrefix: string,
  since: string,
  /** The newest match instead of the oldest (a review thread: an older one may be a stopped attempt). */
  newest = false,
): Promise<string | null> {
  const after = slackBefore(since);
  const [row] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.userId, scope.userId),
        eq(threads.projectId, scope.projectId),
        eq(threads.source, 'factory'),
        // The prefix (`[Factory] #N `) is stable; the issue title may have changed.
        like(threads.title, `${titlePrefix}%`),
        gte(threads.createdAt, after),
      ),
    )
    .orderBy(newest ? desc(threads.createdAt) : asc(threads.createdAt))
    .limit(1);
  return row?.id ?? null;
}
