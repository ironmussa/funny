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
import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.FUNNY_DATA_DIR) {
  const dataDir = mkdtempSync(join(tmpdir(), 'funny-runtime-test-'));
  process.env.FUNNY_DATA_DIR = dataDir;
  // The preload runs once per test file, so this removes that file's dir after
  // its last test; without it every run leaves one behind per file. (Bun does
  // not fire `exit` for a test file's global.)
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
}
