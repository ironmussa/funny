/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: utility
 * @domain layer: domain
 *
 * Detects per-directory environment requirements (Python venv, Node version)
 * and returns the merged env-var mutations needed to "activate" them for a
 * spawned process — without sourcing any shell-specific activation script.
 *
 * Each resolver runs independently and returns a partial mutation. PATH
 * prepends are stacked so multiple resolvers compose cleanly.
 */

import { resolveNodeVersion } from './nvmrc.js';
import { resolvePyVenv } from './venv.js';

export interface DetectedEnv {
  /** Env-var mutations to merge into the spawn env. */
  env: Record<string, string | undefined>;
  /** Human-readable list of activations applied (for logging). */
  notes: Array<{ kind: 'python-venv' | 'node-version'; detail: string }>;
}

/**
 * Run all per-directory environment resolvers and return a merged mutation set.
 * Always returns an object — `env` may be empty and `notes` may be empty if no
 * resolvers matched. Caller merges `env` into the spawn env via Object.assign.
 */
export function detectEnv(
  cwd: string,
  parentEnv: Record<string, string | undefined> = process.env,
): DetectedEnv {
  const env: Record<string, string | undefined> = {};
  const notes: DetectedEnv['notes'] = [];

  // Track PATH so each resolver prepends onto the previous result, not the
  // original parentEnv PATH — otherwise the second resolver would clobber
  // the first's prepend.
  let workingEnv = parentEnv;

  const node = resolveNodeVersion(cwd, workingEnv);
  if (node) {
    Object.assign(env, node.env);
    workingEnv = { ...workingEnv, ...node.env };
    notes.push({ kind: 'node-version', detail: `v${node.version} (${node.binPath})` });
  }

  const venv = resolvePyVenv(cwd, workingEnv);
  if (venv) {
    Object.assign(env, venv.env);
    notes.push({ kind: 'python-venv', detail: venv.venvPath });
  }

  return { env, notes };
}

export { resolvePyVenv, type PyVenvResolution } from './venv.js';
export { resolveNodeVersion, type NodeVersionResolution } from './nvmrc.js';
