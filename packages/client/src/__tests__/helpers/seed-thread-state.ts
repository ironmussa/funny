import type { Thread } from '@funny/shared';

import { listedProjectThreadIds, readThreadIndex } from '@/data/threads/read';
import { seedProjectThreads } from '@/data/threads/testing';
import { deriveOrderedThreads } from '@/data/threads/views';

/**
 * Test helper: seed the session's threads collection from the legacy
 * `{ projectId → Thread[] }` fixture shape. Returns an empty store patch so
 * existing call sites keep composing it into `setState`:
 *
 *   useThreadStore.setState({ ...seedThreads({ p1: [t1] }), selectedThreadId: 't1' });
 */
export function seedThreads(threadsByProject: Record<string, Thread[]>): Record<string, never> {
  seedProjectThreads(threadsByProject);
  return {};
}

/** A project's listed rows as a plain array (data layer). The state argument is ignored. */
export function readProjectThreads(_state: unknown, projectId: string): Thread[] {
  return deriveOrderedThreads(readThreadIndex().threadsById, listedProjectThreadIds(projectId));
}
