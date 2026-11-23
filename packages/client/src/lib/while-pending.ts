/**
 * Runs `task` with a pending flag raised, and lowers it when the task settles,
 * also when it throws.
 *
 * Why a helper: React Compiler cannot compile a `finally` clause, so a
 * component or hook with `try { … } finally { setLoading(false) }` is skipped
 * whole, and its memoization lints then misread the callback's dependencies.
 * Outside a component the `finally` costs nothing.
 */
export async function whilePending<T>(
  setPending: (pending: boolean) => void,
  task: () => Promise<T>,
): Promise<T> {
  setPending(true);
  try {
    return await task();
  } finally {
    setPending(false);
  }
}
