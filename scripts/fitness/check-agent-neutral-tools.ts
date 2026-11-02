#!/usr/bin/env bun
/**
 * Fitness function: funny's agent tools stay agent-neutral.
 *
 * Tools funny gives its agents must reach EVERY provider (Claude, Codex, ACP,
 * LLM API), so they are defined as `AgentToolDefinition`s and served over
 * loopback HTTP by `packages/runtime/src/services/agent-mcp-http.ts`. An
 * in-process Claude SDK server (`createSdkMcpServer`) only works for Claude and
 * silently drops the tools for every other agent — that is how `funny` and
 * `funny_browser` were once Claude-only.
 *
 * Fails when production code in `packages/runtime/src` or `packages/core/src`
 * imports or calls `createSdkMcpServer`. Tests (`__tests__`, `*.test.ts`) are
 * exempt. `--self-test` checks the allowed/forbidden fixtures.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SCANNED = ['packages/runtime/src', 'packages/core/src'];

const FORBIDDEN = [
  /\bcreateSdkMcpServer\s*\(/,
  /import\s*\{[^}]*\bcreateSdkMcpServer\b[^}]*\}\s*from\s*['"]@anthropic-ai\/claude-agent-sdk['"]/,
];

function isTest(path: string): boolean {
  return path.includes('/__tests__/') || /\.test\.tsx?$/.test(path);
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/(^|\/)(node_modules|dist)\//.test(f))
    .map((f) => join(dir, f));
}

/** Violations in one file's source, as `line: text`. */
export function findViolations(source: string): string[] {
  // Imports can span lines: check them on the whole source first.
  const out: string[] = [];
  if (FORBIDDEN[1].test(source)) out.push('import of createSdkMcpServer');
  source.split('\n').forEach((line, i) => {
    if (FORBIDDEN[0].test(line)) out.push(`${i + 1}: ${line.trim()}`);
  });
  return out;
}

function selfTest(): void {
  const forbidden = [
    "import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';",
    "import {\n  createSdkMcpServer,\n} from '@anthropic-ai/claude-agent-sdk';",
    'return createSdkMcpServer({ name: "x" });',
  ];
  const allowed = [
    '// In-process SDK MCP servers (createSdkMcpServer) run inside this process',
    "import { query } from '@anthropic-ai/claude-agent-sdk';",
    'grantAgentMcpHttp(FUNNY_MCP_SERVER, ctx);',
  ];
  const bad = [
    ...forbidden.filter((s) => findViolations(s).length === 0).map((s) => `missed: ${s}`),
    ...allowed.filter((s) => findViolations(s).length > 0).map((s) => `flagged: ${s}`),
  ];
  if (bad.length) {
    console.error(`check-agent-neutral-tools self-test failed:\n${bad.join('\n')}`);
    process.exit(1);
  }
  console.log('check-agent-neutral-tools self-test passed');
}

function main(): void {
  if (process.argv.includes('--self-test')) return selfTest();
  const violations = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .map((file) => relative(ROOT, file))
    .filter((rel) => !isTest(rel))
    .flatMap((rel) =>
      findViolations(readFileSync(join(ROOT, rel), 'utf8')).map((v) => `${rel}:${v}`),
    );
  if (violations.length === 0) {
    console.log('✓ agent tools are agent-neutral (no createSdkMcpServer)');
    return;
  }
  console.error(
    'Agent tools must be agent-neutral: define AgentToolDefinitions and serve them with\n' +
      'grantAgentMcpHttp (packages/runtime/src/services/agent-mcp-http.ts) instead of an\n' +
      'in-process Claude SDK server, which other agents never see.\n\n' +
      violations.join('\n'),
  );
  process.exit(1);
}

main();
