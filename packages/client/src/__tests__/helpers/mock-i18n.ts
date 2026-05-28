/** Shared `t()` mock for component tests — handles defaultValue, count, and title opts. */
export function mockT(key: string, opts?: string | Record<string, unknown>): string {
  if (typeof opts === 'string') return opts;
  if (opts && typeof opts === 'object') {
    if (typeof opts.defaultValue === 'string') return opts.defaultValue;
    if (typeof opts.title === 'string') return `${key}:${opts.title}`;
    if (typeof opts.count === 'number') return `${key}:${opts.count}`;
  }
  return key;
}
