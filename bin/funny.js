#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';
import { parseArgs } from 'util';

// ── Persistent config in ~/.funny/.env ────────────────────

const FUNNY_DIR = join(homedir(), '.funny');
const ENV_FILE = join(FUNNY_DIR, '.env');

/**
 * Parse a simple .env file into key-value pairs.
 * Handles KEY=VALUE, ignores comments (#) and blank lines.
 */
function parseEnvFile(content) {
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
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

/**
 * Load saved env vars from ~/.funny/.env.
 * Only sets values that are NOT already in process.env (env vars take precedence).
 */
function loadSavedEnv() {
  if (!existsSync(ENV_FILE)) return;
  try {
    const content = readFileSync(ENV_FILE, 'utf-8');
    const vars = parseEnvFile(content);
    for (const [key, value] of Object.entries(vars)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Non-fatal — may be corrupted or inaccessible
  }
}

/**
 * Save env vars to ~/.funny/.env, merging with existing values.
 * Creates ~/.funny directory if it doesn't exist.
 */
function saveEnv(updates) {
  // Read existing values
  let existing = {};
  if (existsSync(ENV_FILE)) {
    try {
      existing = parseEnvFile(readFileSync(ENV_FILE, 'utf-8'));
    } catch {}
  }

  // Merge updates
  const merged = { ...existing, ...updates };

  // Write header + key=value pairs
  const lines = ['# Saved by funny CLI — do not edit while running'];
  for (const [key, value] of Object.entries(merged)) {
    lines.push(`${key}=${value}`);
  }

  // Ensure directory exists
  mkdirSync(FUNNY_DIR, { recursive: true });

  // Write with restricted permissions (0o600) — contains tokens
  writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}

// ── Load saved config before parsing CLI args ─────────────
loadSavedEnv();

// ── `funny ext` — manage visualizer extensions (runs without the server) ──
// Dispatched BEFORE the strict parseArgs below, because `ext` subcommands carry
// their own flags (--ref, --subdir) that the top-level parser doesn't know.
{
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'ext') {
    process.exit(await runExtCommand(rawArgs.slice(1)));
  }
}

// ── Parse CLI arguments ───────────────────────────────────

const { values, positionals } = parseArgs({
  options: {
    port: {
      type: 'string',
      short: 'p',
      default: '3001',
    },
    host: {
      type: 'string',
      short: 'h',
      default: '127.0.0.1',
    },
    team: {
      type: 'string',
      description: 'URL of the central server to connect to for team mode',
    },
    token: {
      type: 'string',
      description: 'Runner invite token for team server registration',
    },
    secret: {
      type: 'string',
      description: 'Shared RUNNER_AUTH_SECRET (must match the central server) for team mode',
    },
    help: {
      type: 'boolean',
    },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log(`
funny - Parallel Claude Code agent orchestration

Usage:
  funny [options]

Options:
  -p, --port <port>          Server port (default: 3001)
  -h, --host <host>          Server host (default: 127.0.0.1)
  --team <url>               Connect to a central team server (e.g. http://192.168.1.10:3002)
  --token <token>            Runner invite token for team server registration
  --secret <secret>          Shared RUNNER_AUTH_SECRET — must match the central server (team mode)
  --help                     Show this help message

Team Mode:
  Connect this instance as a runner to a central server:

    funny --team http://192.168.1.10:3002 --secret <secret> --token utkn_xxx

  RUNNER_AUTH_SECRET is a shared secret: the runner MUST use the same value
  as the central server (ask your admin for it). In team mode funny will NOT
  invent one — it refuses to start without it, since a mismatched secret
  breaks every proxied request (browse, agents, git).

  The --team, --secret and --token values are saved to ~/.funny/.env so
  subsequent runs only need:

    funny

  To change the server, pass --team again with a new URL.

Examples:
  funny                          # Start standalone on http://127.0.0.1:3001
  funny --port 8080              # Start on custom port
  funny --team http://central:3002 --secret abc123 --token utkn_xxx  # Connect to team server (saves config)
  funny --team http://central:3002  # Re-connect with saved secret + token

Authentication:
  Always uses Better Auth with login page. Default admin account (admin/admin)
  is created on first startup. Change the password immediately.

Environment Variables:
  PORT                       Server port
  HOST                       Server host
  TEAM_SERVER_URL            Central team server URL (same as --team)
  RUNNER_INVITE_TOKEN        Runner invite token (same as --token)
  RUNNER_AUTH_SECRET         Shared secret matching the central server (same as --secret)
  CORS_ORIGIN                Custom CORS origins (comma-separated)
  DB_MODE                    Database mode: sqlite (default) or postgres
  DATABASE_URL               PostgreSQL connection URL (when DB_MODE=postgres)

Config:
  Saved config:  ~/.funny/.env
  Database:      ~/.funny/data.db

For more information, visit: https://github.com/anthropics/funny
`);
  process.exit(0);
}

// ── Set environment variables from CLI args ───────────────

process.env.PORT = values.port;
process.env.HOST = values.host;

// CLI --team and --token override env vars and saved config
if (values.team) {
  process.env.TEAM_SERVER_URL = values.team;
}
if (values.token) {
  process.env.RUNNER_INVITE_TOKEN = values.token;
}
if (values.secret) {
  process.env.RUNNER_AUTH_SECRET = values.secret;
}

// ── Save team config when provided via CLI ────────────────

const toSave = {};
if (values.team) toSave.TEAM_SERVER_URL = values.team;
if (values.token) toSave.RUNNER_INVITE_TOKEN = values.token;
if (values.secret) toSave.RUNNER_AUTH_SECRET = values.secret;

if (Object.keys(toSave).length > 0) {
  try {
    saveEnv(toSave);
    console.log(`[funny] Config saved to ${ENV_FILE}`);
  } catch (err) {
    console.warn(`[funny] Warning: could not save config to ${ENV_FILE}:`, err.message);
  }
}

// ── Team mode log ─────────────────────────────────────────

if (process.env.TEAM_SERVER_URL) {
  const source = values.team ? 'CLI' : existsSync(ENV_FILE) ? 'saved config' : 'env';
  console.log(
    `[funny] Team mode enabled — connecting to ${process.env.TEAM_SERVER_URL} (from ${source})`,
  );
}

// ── Resolve RUNNER_AUTH_SECRET ─────────────────────────────
// RUNNER_AUTH_SECRET is a SHARED secret: in team mode the runner and the
// central server must hold the SAME value (it's the HMAC key for the
// forwarded-identity signature). Minting a random one here would silently
// break every proxied request — browse, agents, git — with a 500 from the
// server's auth middleware, because the signature would never validate.
// So in team mode require it explicitly and fail with a clear message.
// Only standalone all-in-one mode (no remote server) may generate its own,
// since there the secret is purely process-internal.

if (!process.env.RUNNER_AUTH_SECRET) {
  if (process.env.TEAM_SERVER_URL) {
    console.error(
      '\n[funny] ERROR: RUNNER_AUTH_SECRET is required in team mode.\n\n' +
        'This runner connects to a central server and must use the SAME\n' +
        'RUNNER_AUTH_SECRET as that server. Ask your admin for it, then pass\n' +
        'it via flag or env (it is saved to ~/.funny/.env for next time):\n\n' +
        `  funny --team ${process.env.TEAM_SERVER_URL} --secret <secret-from-admin> --token <invite-token>\n\n` +
        'or:\n\n' +
        `  RUNNER_AUTH_SECRET=<secret-from-admin> funny --team ${process.env.TEAM_SERVER_URL}\n`,
    );
    process.exit(1);
  }
  const crypto = await import('crypto');
  process.env.RUNNER_AUTH_SECRET = crypto.randomUUID();
}

// ── Resolve entry points and start ────────────────────────

const serverEntry = resolve(import.meta.dir, '../packages/server/dist/index.js');
const serverSrc = resolve(import.meta.dir, '../packages/server/src/index.ts');
const runtimeEntry = resolve(import.meta.dir, '../packages/runtime/dist/index.js');
const runtimeSrc = resolve(import.meta.dir, '../packages/runtime/src/index.ts');

// Try server first (unified architecture), then runtime (standalone)
if (existsSync(serverEntry)) {
  console.log('[funny] Starting from built server...');
  await import(serverEntry);
} else if (existsSync(serverSrc)) {
  console.log('[funny] Starting from server source...');
  await import(serverSrc);
} else if (existsSync(runtimeEntry)) {
  console.log('[funny] Starting from built runtime (standalone mode)...');
  await import(runtimeEntry);
} else if (existsSync(runtimeSrc)) {
  console.log('[funny] Starting from runtime source (standalone mode)...');
  await import(runtimeSrc);
} else {
  console.error('[funny] Error: Server files not found.');
  console.error('Please run "bun install" and "bun run build" first.');
  process.exit(1);
}

// ── `funny ext` implementation ────────────────────────────
// Reuses the server's extensions lib (built dist, else source) so the on-disk
// layout + validation stay identical to the running server. Returns an exit code.
async function runExtCommand(args) {
  const sub = args[0];
  const libDist = resolve(import.meta.dir, '../packages/server/dist/lib/extensions.js');
  const libSrc = resolve(import.meta.dir, '../packages/server/src/lib/extensions.ts');
  const libPath = existsSync(libDist) ? libDist : libSrc;
  let lib;
  try {
    lib = await import(libPath);
  } catch (err) {
    console.error('[funny] Could not load the extensions module:', err.message);
    return 1;
  }
  const {
    listInstalledExtensions,
    installExtensionFromPath,
    installExtensionFromGit,
    removeExtension,
  } = lib;

  if (sub === 'list' || sub === 'ls') {
    const exts = listInstalledExtensions();
    if (exts.length === 0) {
      console.log('No extensions installed.');
      return 0;
    }
    for (const e of exts) {
      console.log(`  ${e.name.padEnd(28)} ${e.id}@${e.version}`);
    }
    return 0;
  }

  if (sub === 'install' || sub === 'add') {
    const rest = args.slice(1);
    const flag = (name) => {
      const i = rest.indexOf(name);
      if (i === -1 || i + 1 >= rest.length) return undefined;
      const v = rest[i + 1];
      rest.splice(i, 2);
      return v;
    };
    const ref = flag('--ref');
    const subdir = flag('--subdir');
    const src = rest.find((a) => !a.startsWith('-'));
    if (!src) {
      console.error(
        'Usage: funny ext install <path | git-url> [--ref <branch|tag>] [--subdir <dir>]',
      );
      return 1;
    }
    // A git URL (github:user/repo, https://…, git@host:…) installs remotely;
    // anything else is treated as a local package directory.
    const isGit = /^(github:|gh:|https:\/\/|git@|ssh:\/\/)/i.test(src);
    const r = isGit
      ? await installExtensionFromGit(src, { ref, subdir })
      : installExtensionFromPath(resolve(src));
    if (r.ok) {
      console.log(`Installed ${r.extension.id}@${r.extension.version} → ${r.extension.name}`);
      return 0;
    }
    console.error(`Install failed: ${r.error}`);
    return 1;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
    const name = args[1];
    if (!name) {
      console.error('Usage: funny ext remove <name>');
      return 1;
    }
    const r = removeExtension(name);
    if (r.ok) {
      console.log(`Removed ${name}`);
      return 0;
    }
    console.error(`Remove failed: ${r.error}`);
    return 1;
  }

  console.log(`funny ext — manage visualizer extensions

Usage:
  funny ext list                       List installed extensions
  funny ext install <path>             Install a local pre-built package directory
  funny ext install <git-url>          Install from a git repo (pre-built dist)
       [--ref <branch|tag>] [--subdir <dir>]
  funny ext remove <name>              Remove an installed extension

Git URL forms: github:user/repo · https://host/user/repo(.git) · git@host:user/repo
A trailing #ref also selects a branch/tag, e.g. github:user/repo#v1.2.0

Extensions live in ~/.funny/extensions/. Starter template and reference
extensions: https://github.com/ironmussa/funny-extensions`);
  return sub ? 1 : 0; // unknown subcommand → error
}
