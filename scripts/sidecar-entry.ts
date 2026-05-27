#!/usr/bin/env bun

// Entry point compiled by `bun build --compile` into the Tauri sidecar binary.
//
// The Tauri shell plugin spawns this binary with an empty environment, so we
// have to bootstrap the env the same way `bin/funny.js` does before importing
// the server. Specifically:
//   • Load saved values from `~/.funny/.env` (TEAM_SERVER_URL, tokens, etc.).
//   • Generate `RUNNER_AUTH_SECRET` if missing — the server exits otherwise.
//   • Default PORT to 3001 so it matches the client's hard-coded baseURL.

import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const FUNNY_DIR = join(homedir(), '.funny');
const ENV_FILE = join(FUNNY_DIR, '.env');

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

if (existsSync(ENV_FILE)) {
  try {
    const vars = parseEnvFile(readFileSync(ENV_FILE, 'utf-8'));
    for (const [key, value] of Object.entries(vars)) {
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Non-fatal — corrupted file should not block startup.
  }
}

if (!process.env.RUNNER_AUTH_SECRET) {
  const secret = crypto.randomUUID();
  process.env.RUNNER_AUTH_SECRET = secret;
  try {
    mkdirSync(FUNNY_DIR, { recursive: true });
    const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8') : '';
    if (!/^RUNNER_AUTH_SECRET=/m.test(existing)) {
      const sep = existing && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(ENV_FILE, `${existing}${sep}RUNNER_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
    }
  } catch {
    // Persisting is best-effort; in-memory secret is enough for this run.
  }
}

if (!process.env.PORT) process.env.PORT = '3001';
if (!process.env.HOST) process.env.HOST = '127.0.0.1';

await import('../packages/server/src/index.ts');
