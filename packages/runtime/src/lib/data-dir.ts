/**
 * @domain subdomain: Shared Kernel
 * @domain type: value-object
 * @domain layer: infrastructure
 */

import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

/**
 * Centralized data directory for all persistent files (DB, auth, keys, logs).
 * Override with FUNNY_DATA_DIR env var (use an absolute path, ~ is not expanded).
 */
export const DATA_DIR = process.env.FUNNY_DATA_DIR
  ? resolve(process.env.FUNNY_DATA_DIR)
  : resolve(homedir(), '.funny');

console.debug(`[data-dir] FUNNY_DATA_DIR env = ${JSON.stringify(process.env.FUNNY_DATA_DIR)}`);
console.debug(`[data-dir] Resolved DATA_DIR = ${DATA_DIR}`);

// Ensure the directory exists on import
mkdirSync(DATA_DIR, { recursive: true });
