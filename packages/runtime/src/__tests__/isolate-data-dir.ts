/**
 * Preloaded by `bun test` (bunfig.toml) before every runtime test file: points
 * FUNNY_DATA_DIR at a temp dir of its own unless the run sets one.
 *
 * `bun test` does not hoist module mocks above imports, so a module that reads
 * DATA_DIR at import time (the PTY daemon launcher's socket path, the uploads
 * staging dir…) can see the real one before a test's mock applies. Without this,
 * such a test writes into the user's `~/.funny`, and a PTY daemon it spawns
 * replaces the user's `pty.sock`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.FUNNY_DATA_DIR) {
  process.env.FUNNY_DATA_DIR = mkdtempSync(join(tmpdir(), 'funny-runtime-test-'));
}
