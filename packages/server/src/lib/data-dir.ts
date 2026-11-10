import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

/**
 * Data directory for the server.
 * Defaults to ~/.funny (same as runtime in local mode).
 * Override with FUNNY_DATA_DIR or FUNNY_CENTRAL_DATA_DIR env var.
 *
 * Importing this module touches no filesystem (a host may have none —
 * docs/plans/cloudflare-portability.md, Phase 1). Code that writes under it
 * calls `ensureDataDir()` first; the Bun host calls it at boot.
 */
export const DATA_DIR = process.env.FUNNY_DATA_DIR
  ? resolve(process.env.FUNNY_DATA_DIR)
  : process.env.FUNNY_CENTRAL_DATA_DIR
    ? resolve(process.env.FUNNY_CENTRAL_DATA_DIR)
    : resolve(homedir(), '.funny');

let ensured = false;

/** Create the data directory (owner-only) if needed and return it. */
export function ensureDataDir(): string {
  if (!ensured) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    ensured = true;
  }
  return DATA_DIR;
}
