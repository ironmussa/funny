/**
 * Safe accessor for the git-derived build identity.
 *
 * `__BUILD_INFO__` is injected as a compile-time constant by Bun.build's
 * `define` (see packages/runtime/build.ts and scripts/build-info.ts). In dev the
 * source runs unbundled with no define, so the `typeof` guard falls back to a
 * "dev" label instead of throwing a ReferenceError.
 */
declare const __BUILD_INFO__:
  | { version: string; build: number; commit: string; dirty: boolean; label: string }
  | undefined;

export const BUILD_INFO =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { version: '0.0.0', build: 0, commit: 'dev', dirty: false, label: 'dev (unbundled)' };
