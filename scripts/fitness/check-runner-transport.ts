#!/usr/bin/env bun
/** Prevent runner-v1 transport surfaces from returning after the gRPC-only migration. */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const TEAM_CLIENT_IMPORT_ALLOWLIST = new Set([
  'packages/runtime/src/app/init-runtime.ts',
  'packages/runtime/src/app/pty-message-handler.ts',
]);

interface Rule {
  name: string;
  forbidden: RegExp;
}

const SOURCE_RULES: Rule[] = [
  {
    name: 'runner Socket.IO namespace',
    forbidden: /(?:\.of|namespace)\s*\(\s*['"]\/runner['"]|['"]\/runner['"]\s*:\s*(?:io|socket)/,
  },
  {
    name: 'removed runner transport configuration',
    forbidden: /\b(?:RUNNER_GRPC_V1|RUNNER_GRPC_CANARY|RUNNER_HTTP_URL|DEFAULT_RUNNER_URL)\b/,
  },
  {
    name: 'direct runner HTTP routing',
    forbidden: /\b(?:directFetch|directRunnerFetch|runnerHttpUrl)\b/,
  },
  {
    name: 'global runner transport locator',
    forbidden:
      /\b(?:setRunnerGrpcTransport|getRunnerGrpcTransport|setGrpcBrowserTransport|getGrpcBrowserTransport)\b|grpc-browser-transport/,
  },
  {
    name: 'monolithic runner facade import',
    forbidden: /(?:\bfrom\s+|\bimport\s*\()\s*['"][^'"]*team-client(?:\.js)?['"]/,
  },
];

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (
      entry === 'node_modules' ||
      entry === 'dist' ||
      entry === 'generated' ||
      entry === '__tests__'
    ) {
      continue;
    }
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) yield* walk(path);
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry)) yield path;
  }
}

function classify(source: string, file: string): string[] {
  const violations: string[] = [];
  source.split('\n').forEach((line, index) => {
    for (const rule of SOURCE_RULES) {
      if (
        rule.name === 'monolithic runner facade import' &&
        TEAM_CLIENT_IMPORT_ALLOWLIST.has(file)
      ) {
        continue;
      }
      if (rule.forbidden.test(line)) {
        violations.push(`[${rule.name}] ${file}:${index + 1}  ${line.trim()}`);
      }
    }
  });
  return violations;
}

function runSelfTest(): void {
  const allowed = [
    "const browser = io.of('/browser');",
    'const endpoint = env.RUNNER_GRPC_ENDPOINT;',
    "fetch('/api/runners/register');",
  ];
  const forbidden = [
    "const runner = io.of('/runner');",
    'const enabled = env.RUNNER_GRPC_V1;',
    'return directFetch(runner.url, request);',
    'setRunnerGrpcTransport(transport);',
  ];
  for (const source of allowed) {
    if (classify(source, 'allowed.ts').length > 0) {
      throw new Error(`runner transport self-test rejected allowed source: ${source}`);
    }
  }
  for (const source of forbidden) {
    if (classify(source, 'forbidden.ts').length === 0) {
      throw new Error(`runner transport self-test accepted forbidden source: ${source}`);
    }
  }
  const facadeImport = "import { remoteGetThread } from './team-client.js';";
  if (classify(facadeImport, 'packages/runtime/src/services/new-consumer.ts').length === 0) {
    throw new Error('runner transport self-test accepted a new monolithic facade import');
  }
  if (
    classify(
      "const lifecycle = import('../services/team-client.js');",
      'packages/runtime/src/app/init-runtime.ts',
    ).length > 0
  ) {
    throw new Error('runner transport self-test rejected an allowlisted lifecycle import');
  }
  console.log('runner transport self-test ok');
}

const violations: string[] = [];
let sessionRegistryDeclarations = 0;
for (const directory of ['packages/runtime/src', 'packages/server/src']) {
  for (const file of walk(join(ROOT, directory))) {
    const source = readFileSync(file, 'utf8');
    const relativeFile = relative(ROOT, file);
    violations.push(...classify(source, relativeFile));
    sessionRegistryDeclarations +=
      source.match(/\bclass\s+RunnerGrpcSessionRegistry\b/g)?.length ?? 0;

    if (
      relativeFile.startsWith('packages/server/src/routes/') ||
      relativeFile.startsWith('packages/server/src/middleware/') ||
      relativeFile.startsWith('packages/server/src/services/socketio/')
    ) {
      source.split('\n').forEach((line, index) => {
        if (/(?:\bfrom\s+|\bimport\s*\()\s*['"][^'"]*(?:\/grpc\/|services\/grpc)/.test(line)) {
          violations.push(
            `[presentation-to-gRPC import] ${relativeFile}:${index + 1}  ${line.trim()}`,
          );
        }
      });
    }
  }
}

if (sessionRegistryDeclarations !== 1) {
  violations.push(
    `[runner presence authority] expected exactly one RunnerGrpcSessionRegistry declaration, found ${sessionRegistryDeclarations}`,
  );
}

for (const removedPath of [
  'packages/server/src/services/grpc-browser-transport.ts',
  'packages/server/src/services/socketio/runner-namespace.ts',
  'packages/server/src/services/ws-relay.ts',
  'packages/server/src/services/ws-tunnel.ts',
  'protocol/runner/v1',
]) {
  if (existsSync(join(ROOT, removedPath))) {
    violations.push(`[removed runner-v1 surface] ${removedPath} must remain absent`);
  }
}

for (const file of ['.env.example', 'packages/runtime/package.json']) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, 'utf8');
  violations.push(...classify(source, file));
}

const runtimePackage = JSON.parse(
  readFileSync(join(ROOT, 'packages/runtime/package.json'), 'utf8'),
) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
if (
  runtimePackage.dependencies?.['socket.io-client'] ||
  runtimePackage.optionalDependencies?.['socket.io-client']
) {
  violations.push(
    '[runtime Socket.IO dependency] packages/runtime/package.json  socket.io-client must remain absent',
  );
}

if (process.argv.includes('--self-test')) runSelfTest();

if (violations.length > 0) {
  console.error('Runner transport fitness violations:\n');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log('runner transport ok — gRPC remains the only runner data plane');
