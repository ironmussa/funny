/// <reference types="vite/client" />

/**
 * Build identity injected at build time via Vite `define` (see vite.config.ts
 * and scripts/build-info.ts). In `vite dev` it is replaced too, so it is always
 * defined when the app runs through Vite.
 */
declare const __BUILD_INFO__: {
  /** Semver from package.json, e.g. "0.1.3". */
  version: string;
  /** Git commit count — short, autoincremental build number, e.g. 142. */
  build: number;
  /** Short commit hash, e.g. "a1b2c3d". */
  commit: string;
  /** True when built from a dirty working tree. */
  dirty: boolean;
  /** Human-readable label, e.g. "0.1.3 · build 142 (a1b2c3d)". */
  label: string;
};
