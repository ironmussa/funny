import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

/**
 * Data directory for the server.
 * Defaults to ~/.funny (same as runtime in local mode).
 * Override with FUNNY_DATA_DIR or FUNNY_CENTRAL_DATA_DIR env var.
 */
export const DATA_DIR = process.env.FUNNY_DATA_DIR
  ? resolve(process.env.FUNNY_DATA_DIR)
  : process.env.FUNNY_CENTRAL_DATA_DIR
    ? resolve(process.env.FUNNY_CENTRAL_DATA_DIR)
    : resolve(homedir(), '.funny');

// Ensure the directory exists on import
mkdirSync(DATA_DIR, { recursive: true });
