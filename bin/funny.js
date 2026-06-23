#!/usr/bin/env bun
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';
import { parseArgs } from 'util';

// ── Persistent config in ~/.funny/.env ────────────────────

const FUNNY_DIR = join(homedir(), '.funny');
const ENV_FILE = join(FUNNY_DIR, '.env');
const TEAM_ENV_KEYS = new Set(['TEAM_SERVER_URL', 'RUNNER_INVITE_TOKEN', 'RUNNER_AUTH_SECRET']);

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
 * Team connection keys are intentionally ignored: connecting to a central server
 * must be requested explicitly with --team.
 */
function loadSavedEnv() {
  if (!existsSync(ENV_FILE)) return;
  try {
    const content = readFileSync(ENV_FILE, 'utf-8');
    const vars = parseEnvFile(content);
    for (const [key, value] of Object.entries(vars)) {
      if (TEAM_ENV_KEYS.has(key)) continue;
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Non-fatal — may be corrupted or inaccessible
  }
}

// ── `funny ext` — manage visualizer extensions (runs without the server) ──
// Dispatched BEFORE the strict parseArgs below, because `ext` subcommands carry
// their own flags (--ref, --subdir) that the top-level parser doesn't know.
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === 'ext') {
  process.exit(await runExtCommand(rawArgs.slice(1)));
}

// ── Parse CLI arguments ───────────────────────────────────

const { values } = parseArgs({
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
      description: 'URL of the central server to connect to as a runner',
    },
    token: {
      type: 'string',
      description: 'Runner invite token for team server registration',
    },
    secret: {
      type: 'string',
      description:
        'Shared RUNNER_AUTH_SECRET (must match the central server) for classic runner registration',
    },
    local: {
      type: 'boolean',
      default: false,
    },
    help: {
      type: 'boolean',
    },
  },
  allowPositionals: true,
});

if (values.local && values.team) {
  console.error('[funny] ERROR: --local cannot be combined with --team.');
  process.exit(1);
}

// Saved and inherited team credentials are intentionally ignored unless --team
// is present. A plain `funny` or `bunx @ironmussa/funny` should always start
// local, even if the shell or ~/.funny/.env contains stale team variables.
loadSavedEnv();

if (!values.team || values.local) {
  delete process.env.TEAM_SERVER_URL;
  delete process.env.RUNNER_INVITE_TOKEN;
  delete process.env.RUNNER_AUTH_SECRET;
}

if (values.help) {
  console.log(`
funny - Parallel Claude Code agent orchestration

Usage:
  funny [options]

Options:
  -p, --port <port>          Server port (default: 3001)
  -h, --host <host>          Server host (default: 127.0.0.1)
  --team <url>               Connect this machine as a runner to a central server
  --token <token>            Runner invite token for team server registration
  --secret <secret>          Shared RUNNER_AUTH_SECRET — classic runner registration only
  --local                    Start standalone; cannot be combined with --team
  --help                     Show this help message

Runner Mode:
  Connect this machine as a runner to a central server. The easy path is
  device-link enrollment — just point at the server:

    funny --team http://192.168.1.10:3002

  funny prints a short code; open the server, go to Settings ▸ Runners ▸
  "Link a runner", enter the code, and approve. The runner then receives its
  credentials automatically — no secret or token to copy.

  Classic flow (advanced): you may instead supply the shared secret + an invite
  token yourself. RUNNER_AUTH_SECRET must match the central server's value:

    funny --team http://192.168.1.10:3002 --secret <secret> --token utkn_xxx

  To change the server, pass --team again with a new URL.

Examples:
  funny                          # Start all-in-one local app on http://127.0.0.1:3001
  funny --port 8080              # Start on custom port
  funny --team http://central:3002  # Connect via device-link enrollment (recommended)
  funny --team http://central:3002 --secret abc123 --token utkn_xxx  # Classic flow

Authentication:
  Always uses Better Auth with login page. Default admin account (admin/admin)
  is created on first startup. Change the password immediately.

Environment Variables:
  PORT                       Server port
  HOST                       Server host
  RUNNER_INVITE_TOKEN        Runner invite token for --team classic flow
  RUNNER_AUTH_SECRET         Shared secret for --team classic flow
  CORS_ORIGIN                Custom CORS origins (comma-separated)
  DB_MODE                    Database mode: sqlite (default) or postgres
  DATABASE_URL               PostgreSQL connection URL (when DB_MODE=postgres)

Config:
  Saved config:  ~/.funny/.env
  Note: saved and inherited team connection keys are ignored; pass --team to connect.
  Database:      ~/.funny/data.db

For more information, visit: https://github.com/anthropics/funny
`);
  process.exit(0);
}

// ── Set environment variables from CLI args ───────────────

process.env.PORT = values.port;
process.env.HOST = values.host;
const isTeamMode = !!values.team;

// CLI --team and --token override env vars for this process only.
if (values.team) {
  process.env.TEAM_SERVER_URL = values.team;
}
if (values.token) {
  process.env.RUNNER_INVITE_TOKEN = values.token;
}
if (values.secret) {
  process.env.RUNNER_AUTH_SECRET = values.secret;
}

// ── Runner mode log ───────────────────────────────────────

if (isTeamMode) {
  console.log(
    `[funny] Runner mode enabled — connecting to ${process.env.TEAM_SERVER_URL} (from CLI)`,
  );
}

// ── Resolve RUNNER_AUTH_SECRET ─────────────────────────────
// RUNNER_AUTH_SECRET is a SHARED secret: in team mode the runner and the
// central server must hold the SAME value (it's the HMAC key for the
// forwarded-identity signature). Minting a random one here would silently
// break every proxied request — browse, agents, git — with a 500 from the
// server's auth middleware, because the signature would never validate.
//
// Default path is now device-link enrollment: with no secret and no invite
// token, the runtime shows a code and obtains its secret from the server after
// the operator approves it in the UI — so we must NOT abort or mint a random
// secret there. Only standalone all-in-one mode generates its own, and the
// classic --token flow still requires an explicit secret.

if (!process.env.RUNNER_AUTH_SECRET) {
  if (process.env.TEAM_SERVER_URL) {
    // Classic invite-token flow still needs the shared secret for proxied
    // requests, so flag a token supplied without a secret.
    if (process.env.RUNNER_INVITE_TOKEN) {
      console.error(
        '\n[funny] ERROR: RUNNER_AUTH_SECRET is required when using --token in team mode.\n\n' +
          'This runner connects to a central server and must use the SAME\n' +
          'RUNNER_AUTH_SECRET as that server. Ask your admin for it, then pass\n' +
          'it via flag or env:\n\n' +
          `  funny --team ${process.env.TEAM_SERVER_URL} --secret <secret-from-admin> --token <invite-token>\n\n` +
          'Or drop --token and use device-link enrollment (no secret needed):\n\n' +
          `  funny --team ${process.env.TEAM_SERVER_URL}\n`,
      );
      process.exit(1);
    }
    // Device-link path: no token, no secret. Leave the secret unset — the
    // runtime resumes persisted credentials if present, otherwise enrolls
    // (printing a code to approve in the funny UI) and receives its secret then.
    console.log(
      '[funny] No runner secret/token set — connecting via device-link enrollment.\n' +
        '        A code will be printed below; approve it in Settings ▸ Runners.',
    );
  } else {
    const crypto = await import('crypto');
    process.env.RUNNER_AUTH_SECRET = crypto.randomUUID();
  }
}

// ── Resolve entry points and start ────────────────────────

const serverEntry = resolve(import.meta.dir, '../packages/server/dist/index.js');
const serverSrc = resolve(import.meta.dir, '../packages/server/src/index.ts');
const runtimeEntry = resolve(import.meta.dir, '../packages/runtime/dist/index.js');
const runtimeSrc = resolve(import.meta.dir, '../packages/runtime/src/index.ts');

function resolveServerEntry() {
  if (existsSync(serverEntry)) return { path: serverEntry, label: 'built server' };
  if (existsSync(serverSrc)) return { path: serverSrc, label: 'server source' };
  return null;
}

function resolveRuntimeEntry() {
  if (existsSync(runtimeEntry)) return { path: runtimeEntry, label: 'built runtime' };
  if (existsSync(runtimeSrc)) return { path: runtimeSrc, label: 'runtime source' };
  return null;
}

async function startRuntimeInThisProcess() {
  const entry = resolveRuntimeEntry();
  if (!entry) {
    console.error('[funny] Error: Runtime files not found.');
    console.error('Please run "bun install" and "bun run build" first.');
    process.exit(1);
  }
  console.log(`[funny] Starting from ${entry.label}...`);
  await import(entry.path);
}

function ensureLoopbackRunnerOptIn() {
  process.env.FUNNY_LOOPBACK_RUNNER_USERNAME ||= process.env.ADMIN_USERNAME || 'admin';
  return process.env.FUNNY_LOOPBACK_RUNNER_USERNAME;
}

function startLocalRuntime(serverUrl) {
  const entry = resolveRuntimeEntry();
  if (!entry) {
    console.warn('[funny] Warning: Runtime files not found; local agent runner was not started.');
    return;
  }

  const loopbackRunnerUsername = ensureLoopbackRunnerOptIn();
  const env = {
    ...process.env,
    TEAM_SERVER_URL: serverUrl,
    RUNNER_AUTH_SECRET: process.env.RUNNER_AUTH_SECRET,
    WS_TUNNEL_ONLY: process.env.WS_TUNNEL_ONLY || 'true',
    FUNNY_LOOPBACK_RUNNER_USERNAME: loopbackRunnerUsername,
  };

  console.log(`[funny] Starting local runner from ${entry.label} -> ${serverUrl}`);
  const child = Bun.spawn({
    cmd: [process.execPath, entry.path],
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  let shuttingDown = false;
  const stopChild = (signal = 'SIGTERM') => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(signal);
  };

  process.on('SIGINT', () => stopChild('SIGINT'));
  process.on('SIGTERM', () => stopChild('SIGTERM'));

  child.exited.then((code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[funny] Local runner exited with code ${code}.`);
    }
  });
}

if (isTeamMode) {
  await startRuntimeInThisProcess();
} else {
  const entry = resolveServerEntry();
  if (!entry) {
    console.error('[funny] Error: Server files not found.');
    console.error('Please run "bun install" and "bun run build" first.');
    process.exit(1);
  }

  const localServerUrl = `http://127.0.0.1:${values.port}`;
  ensureLoopbackRunnerOptIn();
  console.log(`[funny] Starting from ${entry.label}...`);
  await import(entry.path);
  startLocalRuntime(localServerUrl);
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
