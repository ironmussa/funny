// Why these helpers: React Compiler cannot compile a `finally` clause, so a
// component or hook that holds one is skipped whole, and its memoization lints
// then misread the callback's dependencies. Outside a component the `finally`
// costs nothing, so components hand their cleanup to these instead.

/** Runs `task`, then `cleanup` once it settles, also when it throws. */
export async function withCleanup<T>(task: () => PromiseLike<T>, cleanup: () => void): Promise<T> {
  try {
    return await task();
  } finally {
    cleanup();
  }
}

/** Synchronous {@link withCleanup}. */
export function withCleanupSync<T>(task: () => T, cleanup: () => void): T {
  try {
    return task();
  } finally {
    cleanup();
  }
}

/**
 * Runs `task` with a pending flag raised, and lowers it when the task settles,
 * also when it throws.
 */
export function whilePending<T>(
  setPending: (pending: boolean) => void,
  task: () => PromiseLike<T>,
): Promise<T> {
  setPending(true);
  return withCleanup(task, () => setPending(false));
}
