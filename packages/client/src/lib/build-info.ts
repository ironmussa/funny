/**
 * Safe accessor for the git-derived build identity.
 *
 * `__BUILD_INFO__` is injected as a compile-time constant by Vite's `define`
 * (see vite.config.ts and scripts/build-info.ts). The `typeof` guard means that
 * if the constant isn't injected — a dev server started before vite.config.ts
 * changed, Storybook, unit tests — this falls back to a "dev" label instead of
 * throwing a ReferenceError on the bare global.
 */
declare const __BUILD_INFO__:
  | { version: string; build: number; commit: string; dirty: boolean; label: string }
  | undefined;

export const BUILD_INFO =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { version: '0.0.0', build: 0, commit: 'dev', dirty: false, label: 'dev (unbundled)' };
