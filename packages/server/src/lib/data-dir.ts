import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

/**
 * Data directory for the central server.
 * Separate from the local funny app (~/.funny/).
 * Override with FUNNY_CENTRAL_DATA_DIR env var.
 */
export const DATA_DIR = process.env.FUNNY_CENTRAL_DATA_DIR
  ? resolve(process.env.FUNNY_CENTRAL_DATA_DIR)
  : resolve(homedir(), '.funny-central');

// Ensure the directory exists on import
mkdirSync(DATA_DIR, { recursive: true });
