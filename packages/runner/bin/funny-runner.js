#!/usr/bin/env bun
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';

const { values } = parseArgs({
  options: {
    server: {
      type: 'string',
      short: 's',
      default: 'http://localhost:3001',
    },
    name: {
      type: 'string',
      short: 'n',
    },
    port: {
      type: 'string',
      short: 'p',
      default: '3002',
    },
    workspace: {
      type: 'string',
      short: 'w',
    },
    help: {
      type: 'boolean',
    },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
funny-runner - Local runner agent for the funny central server

Usage:
  funny-runner [options]

Options:
  -s, --server <url>          Central server URL (default: http://localhost:3001)
  -n, --name <name>           Runner name (default: hostname)
  -p, --port <port>           Local API port for direct git operations (default: 3002)
  -w, --workspace <path>      Base directory where repos live (optional, for admin reference)
  --help                      Show this help message

Examples:
  funny-runner --server http://192.168.1.10:3001
  funny-runner -s http://server:3001 --name "Dev Machine"
  funny-runner --workspace /home/user/repos

The runner registers with the central server as an available machine.
Project assignments are managed from the central server admin UI.
`);
  process.exit(0);
}

// Resolve runner entry point
const runnerEntry = resolve(import.meta.dir, '../dist/index.js');
const runnerSrc = resolve(import.meta.dir, '../src/index.ts');

async function main() {
  let Runner;
  let createLocalApi;

  if (existsSync(runnerEntry)) {
    const mod = await import(runnerEntry);
    Runner = mod.Runner;
    createLocalApi = mod.createLocalApi;
  } else if (existsSync(runnerSrc)) {
    const mod = await import(runnerSrc);
    Runner = mod.Runner;
    createLocalApi = mod.createLocalApi;
  } else {
    console.error('[funny-runner] Runner files not found. Run "bun run build" first.');
    process.exit(1);
  }

  const { hostname } = await import('os');
  const runnerName = values.name || hostname();

  const runner = new Runner({
    serverUrl: values.server,
    name: runnerName,
    workspace: values.workspace,
  });

  // Start the runner (registers with central, connects WS, starts polling)
  await runner.start();

  // Start local API for direct git operations
  const port = parseInt(values.port, 10);
  // The local API needs a token — we'll use the runner's token after registration.
  // For now, generate a simple local token.
  const localToken = crypto.randomUUID();
  const localApi = createLocalApi(localToken);

  Bun.serve({
    port,
    fetch: localApi.fetch,
  });
  console.log(`[funny-runner] Local API listening on http://localhost:${port}`);
  console.log(`[funny-runner] Local API token: ${localToken}`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await runner.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await runner.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[funny-runner] Fatal error:', err);
  process.exit(1);
});
