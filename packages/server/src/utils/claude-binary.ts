/**
 * Claude CLI binary discovery and validation.
 * Finds the claude/claude.exe binary on the system.
 */

import { existsSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';

import { executeSync } from '@funny/core/git';

import { log } from '../lib/logger.js';

const IS_WINDOWS = platform() === 'win32';
const BINARY_NAME = IS_WINDOWS ? 'claude.exe' : 'claude';

/**
 * Search for the binary in PATH using platform-appropriate command.
 */
function findInPath(): string | null {
  try {
    const cmd = IS_WINDOWS ? 'where' : 'which';
    const result = executeSync(cmd, [BINARY_NAME], {
      timeout: 5_000,
      reject: false,
    });
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      const p = line.trim();
      if (p && existsSync(p)) return p;
    }
  } catch {
    // Not in PATH
  }
  return null;
}

/**
 * Check common installation locations.
 */
function findInCommonLocations(): string | null {
  const candidates: string[] = [];

  if (IS_WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const userProfile = process.env.USERPROFILE;

    if (localAppData) {
      candidates.push(join(localAppData, 'Programs', 'claude', BINARY_NAME));
      candidates.push(join(localAppData, 'claude', BINARY_NAME));
    }
    if (appData) {
      candidates.push(join(appData, 'claude', BINARY_NAME));
      candidates.push(join(appData, 'npm', BINARY_NAME));
    }
    if (userProfile) {
      candidates.push(join(userProfile, '.local', 'bin', BINARY_NAME));
      candidates.push(join(userProfile, '.claude', 'local', BINARY_NAME));
    }
  } else {
    candidates.push('/usr/local/bin/claude');
    candidates.push('/usr/bin/claude');
    const home = process.env.HOME;
    if (home) {
      candidates.push(join(home, '.local', 'bin', 'claude'));
      candidates.push(join(home, '.claude', 'local', 'claude'));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the path to the claude binary.
 * Priority:
 *   1. CLAUDE_BINARY_PATH environment variable
 *   2. PATH lookup (where/which)
 *   3. Common installation locations
 */
export function resolveClaudeBinary(): string {
  // 1. Explicit env var
  const envPath = process.env.CLAUDE_BINARY_PATH;
  if (envPath) {
    if (!existsSync(envPath)) {
      throw new Error(`CLAUDE_BINARY_PATH is set to "${envPath}" but the file does not exist`);
    }
    return envPath;
  }

  // 2. PATH lookup
  const pathResult = findInPath();
  if (pathResult) return pathResult;

  // 3. Common locations
  const commonResult = findInCommonLocations();
  if (commonResult) return commonResult;

  throw new Error(`Could not find the claude CLI binary. Install it or set CLAUDE_BINARY_PATH.`);
}

/**
 * Validate the binary by running `claude --version`.
 * Returns the version string.
 */
export function validateClaudeBinary(binaryPath: string): string {
  try {
    const result = executeSync(binaryPath, ['--version'], { timeout: 10_000 });
    return result.stdout.trim();
  } catch (err: any) {
    throw new Error(`Claude binary at "${binaryPath}" is not functional: ${err.message}`, {
      cause: err,
    });
  }
}

/**
 * Get the resolved and validated binary path. Cached after first call.
 */
let cachedBinaryPath: string | null = null;

export function resetBinaryCache(): void {
  cachedBinaryPath = null;
}

export function getClaudeBinaryPath(): string {
  if (!cachedBinaryPath) {
    cachedBinaryPath = resolveClaudeBinary();
    const version = validateClaudeBinary(cachedBinaryPath);
    log.info(`Binary found: ${cachedBinaryPath}`, { namespace: 'claude-binary', version });
  }
  return cachedBinaryPath;
}

/**
 * Check if Claude CLI is installed and available.
 * Returns an object with status and error message if not available.
 */
export function checkClaudeBinaryAvailability(): {
  available: boolean;
  error?: string;
  path?: string;
} {
  try {
    const binaryPath = getClaudeBinaryPath();
    return { available: true, path: binaryPath };
  } catch (err: any) {
    return {
      available: false,
      error: err.message || 'Claude CLI binary not found',
    };
  }
}
