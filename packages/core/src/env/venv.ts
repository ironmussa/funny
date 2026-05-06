/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: utility
 * @domain layer: domain
 *
 * Detects a Python virtual environment in the given cwd and returns the
 * env-var mutations needed to "activate" it for a spawned process — without
 * sourcing the shell-specific `activate` script.
 *
 * Mirrors what VS Code's "Python Environments" feature does and what the
 * `activate` script itself sets: VIRTUAL_ENV, PATH prepend with the venv's
 * bin dir, VIRTUAL_ENV_PROMPT for shells that pick it up, and clears
 * PYTHONHOME so the venv interpreter resolves stdlib correctly.
 */

import { existsSync, statSync } from 'fs';
import { basename, delimiter, resolve } from 'path';

const CANDIDATE_DIRS = ['.venv', 'venv', '.virtualenv'];
const IS_WINDOWS = process.platform === 'win32';
const BIN_DIR = IS_WINDOWS ? 'Scripts' : 'bin';
const PYTHON_BIN = IS_WINDOWS ? 'python.exe' : 'python';

export interface PyVenvResolution {
  /** Absolute path to the venv root. */
  venvPath: string;
  /** Absolute path to the venv's bin/Scripts directory. */
  binPath: string;
  /** Env-var mutations to merge into the spawn env. */
  env: {
    VIRTUAL_ENV: string;
    PATH: string;
    VIRTUAL_ENV_PROMPT: string;
    PYTHONHOME: undefined;
  };
}

function tryVenv(
  venvPath: string,
  parentEnv: Record<string, string | undefined>,
): PyVenvResolution | null {
  const binPath = resolve(venvPath, BIN_DIR);
  const pythonPath = resolve(binPath, PYTHON_BIN);

  if (!existsSync(pythonPath)) return null;
  try {
    if (!statSync(pythonPath).isFile()) return null;
  } catch {
    return null;
  }

  const currentPath = parentEnv.PATH ?? parentEnv.Path ?? '';
  const newPath = currentPath ? `${binPath}${delimiter}${currentPath}` : binPath;

  return {
    venvPath,
    binPath,
    env: {
      VIRTUAL_ENV: venvPath,
      PATH: newPath,
      VIRTUAL_ENV_PROMPT: basename(venvPath),
      PYTHONHOME: undefined,
    },
  };
}

/**
 * Look for a Python venv in `cwd` and return the env mutations needed to
 * activate it. Returns `null` if no venv is detected.
 *
 * Detection requires both the venv directory AND a python binary inside it,
 * so we don't accidentally match an unrelated `.venv` folder.
 *
 * Honors `UV_PROJECT_ENVIRONMENT` (uv's override for the managed venv path) —
 * if set and valid, it takes precedence over the standard candidate names.
 */
export function resolvePyVenv(
  cwd: string,
  parentEnv: Record<string, string | undefined> = process.env,
): PyVenvResolution | null {
  const uvOverride = parentEnv.UV_PROJECT_ENVIRONMENT;
  if (uvOverride && uvOverride.trim()) {
    const overridePath = resolve(cwd, uvOverride);
    const hit = tryVenv(overridePath, parentEnv);
    if (hit) return hit;
  }

  for (const name of CANDIDATE_DIRS) {
    const hit = tryVenv(resolve(cwd, name), parentEnv);
    if (hit) return hit;
  }
  return null;
}
