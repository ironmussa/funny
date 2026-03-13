#!/usr/bin/env bun
import { parseArgs } from 'util';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: 'string', short: 'p', default: '3002' },
    host: { type: 'string', short: 'h', default: '0.0.0.0' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`
  funny-server — Team coordination server for Funny

  Usage:
    funny-server [options]

  Options:
    -p, --port <port>   Port to listen on (default: 3002)
    -h, --host <host>   Host to bind to (default: 0.0.0.0)
        --help          Show this help message

  Environment variables:
    FUNNY_CENTRAL_DATA_DIR   Data directory (default: ~/.funny-server)
    CORS_ORIGIN              Comma-separated allowed origins
    LOG_LEVEL                Log level: debug, info, warn, error (default: info)

  On first start, a default admin account is created:
    Username: admin
    Password: admin

  Example:
    funny-server --port 4000
`);
  process.exit(0);
}

// Set env vars before importing the server
process.env.PORT = values.port;
process.env.HOST = values.host;

// Import and start the central server
await import('../src/index.ts');
