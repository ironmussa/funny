import { THREAD_CONTEXT_HEADER } from '@funny/shared/thread-context';
import type { Context } from 'hono';

/**
 * The client's thread context (`THREAD_CONTEXT_HEADER`) as routing query:
 * `{ threadId }`, or nothing outside a thread. `runner-resolver` routes on it
 * so the request runs where that thread runs.
 */
export function threadContextQuery(c: Context): Record<string, string> {
  const threadId = c.req.header(THREAD_CONTEXT_HEADER)?.trim();
  return threadId ? { threadId } : {};
}
