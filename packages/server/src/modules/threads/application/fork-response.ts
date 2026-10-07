import type { ForkVariant } from './ports.js';

// Legacy response interpretation is deliberately permissive; not an authorization boundary.
/** Where each variant's runner response carries the new thread. */
export function extractForkedThread(variant: ForkVariant, body: unknown): any {
  const data = body as any;
  return variant === 'fork' ? data : (data?.thread ?? null);
}
