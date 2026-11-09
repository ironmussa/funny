/** `map` without `threadId`, or `map` itself when it has no entry for it. */
export function omitThread<T>(map: Record<string, T>, threadId: string): Record<string, T> {
  if (!(threadId in map)) return map;
  const { [threadId]: _removed, ...rest } = map;
  return rest;
}
