#!/usr/bin/env bun
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';

// Parse CLI arguments
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
    'auth-mode': {
      type: 'string',
      default: 'local',
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
  --auth-mode <mode>         Authentication mode: local | multi (default: local)
  --help                     Show this help message

Examples:
  funny                 # Start on http://127.0.0.1:3001
  funny --port 8080     # Start on custom port
  funny --auth-mode multi  # Start in multi-user mode

Environment Variables:
  PORT                       Server port
  HOST                       Server host
  AUTH_MODE                  Authentication mode (local or multi)
  CORS_ORIGIN               Custom CORS origins (comma-separated)

For more information, visit: https://github.com/anthropics/funny
`);
  process.exit(0);
}

// Set environment variables from CLI args
process.env.PORT = values.port;
process.env.HOST = values.host;
process.env.AUTH_MODE = values['auth-mode'];

// Resolve server entry point
const serverEntry = resolve(import.meta.dir, '../packages/server/dist/index.js');
const serverSrc = resolve(import.meta.dir, '../packages/server/src/index.ts');

// Check if built version exists, otherwise use source (for development)
if (existsSync(serverEntry)) {
  console.log('[funny] Starting from built server...');
  await import(serverEntry);
} else if (existsSync(serverSrc)) {
  console.log('[funny] Built server not found, starting from source...');
  console.log('[funny] Run "npm run build" for production use.');
  await import(serverSrc);
} else {
  console.error('[funny] Error: Server files not found.');
  console.error('Please run "npm install" and "npm run build" first.');
  process.exit(1);
}
