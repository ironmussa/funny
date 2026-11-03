/**
 * Read-side API for thread rows and lists. Thread rows live once, in the data
 * layer's threads collection; these hooks are live queries over it (see
 * `src/data/threads/hooks.ts`). Unchanged rows and unchanged lists keep their
 * references across renders, so `memo` components skip repainting.
 *
 * Non-React code reads through `src/data/threads/read.ts`.
 */

// ── React hooks ───────────────────────────────────────────────
//
// Live queries over the data layer's threads collection (the canonical store
// of thread rows). Same names and return shapes as before the migration.
export {
  useScratchThreads,
  useSharedThreads,
  useThreadById,
  useThreadsByProject,
  useThreadsForProject,
} from '@/data/threads/hooks';
