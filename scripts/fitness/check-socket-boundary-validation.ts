#!/usr/bin/env bun
// Fitness function: Socket.IO payload boundary validation baseline diff.
//
// Flags new inbound socket handlers that accept an unknown payload without a
// recognized Zod-backed parse signal. Existing debt, if any, is frozen in
// .fitness/socket-boundary-validation-baseline.txt.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const BASELINE_PATH = join(ROOT, '.fitness', 'socket-boundary-validation-baseline.txt');
const REFRESH = process.argv.includes('--refresh');
const SELF_TEST = process.argv.includes('--self-test');

const SOCKET_INPUT_PATHS = [
  'packages/server/src/services/socketio',
  'packages/runtime/src/services/team-client.ts',
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const LOOKAHEAD_LINES = 12;
const CALL_BLOCK_LINES = 80;

const PARSE_HELPERS = [
  'parseSocketPayload',
  'parseObjectPayload',
  'parseRunnerAgentEvent',
  'parseRunnerBrowserRelay',
  'parseTunnelRequest',
  'parseDataResponse',
  'parseCentralBrowserWs',
  'parseCentralPtyList',
  'parseCentralCommand',
  'parseRunnerDataRequest',
];

interface Violation {
  file: string;
  line: number;
  occurrence: number;
  snippet: string;
  reason: string;
}

interface CheckOptions {
  root: string;
  inputPaths: string[];
  baselinePath: string;
}

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) {
    const ext = path.slice(path.lastIndexOf('.'));
    return SOURCE_EXTENSIONS.has(ext) ? [path] : [];
  }
  const entries = readdirSync(path).sort();
  const files: string[] = [];
  for (const entry of entries) files.push(...walk(join(path, entry)));
  return files;
}

function normalizeSnippet(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validationNear(lines: string[], startIndex: number, variableName: string): boolean {
  const escaped = escapeRegExp(variableName);
  const window = lines.slice(startIndex, startIndex + LOOKAHEAD_LINES + 1).join('\n');
  const helperPattern = PARSE_HELPERS.map(escapeRegExp).join('|');
  return (
    new RegExp(`\\b(?:${helperPattern})\\s*\\([^;]*\\b${escaped}\\b`, 's').test(window) ||
    new RegExp(`\\.safeParse\\s*\\([^;]*\\b${escaped}\\b`, 's').test(window)
  );
}

function socketHandlerPayloadParam(lines: string[], startIndex: number): string | null {
  const window = lines.slice(startIndex, startIndex + 6).join('\n');
  if (!/\b(?:ctx\.)?socket\.on\s*\(/.test(window)) return null;
  const match = window.match(/(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)\s*:\s*(?:unknown|any)\b/);
  return match?.[1] ?? null;
}

function socketRpcPayloadParam(block: string): string | null {
  const match = block.match(
    /handler\s*:\s*(?:async\s*)?\(\s*[^,)]*,\s*[^,)]*,\s*([A-Za-z_$][\w$]*)\b/,
  );
  return match?.[1] ?? null;
}

function registerSocketRpcValidated(block: string, variableName: string): boolean {
  if (/\bpayloadSchema\s*:/.test(block)) return true;
  const escaped = escapeRegExp(variableName);
  const helperPattern = PARSE_HELPERS.map(escapeRegExp).join('|');
  return (
    new RegExp(`\\b(?:${helperPattern})\\s*\\([^;]*\\b${escaped}\\b`, 's').test(block) ||
    new RegExp(`\\.safeParse\\s*\\([^;]*\\b${escaped}\\b`, 's').test(block)
  );
}

function checkFile(absFile: string, root: string): Violation[] {
  const relFile = relative(root, absFile);
  const lines = readFileSync(absFile, 'utf-8').split('\n');
  const violations: Violation[] = [];
  const occurrenceCounts = new Map<string, number>();

  const pushViolation = (lineIndex: number, reason: string) => {
    const snippet = normalizeSnippet(lines[lineIndex] ?? '');
    const occurrenceKey = `${relFile}\t${snippet}\t${reason}`;
    const occurrence = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
    occurrenceCounts.set(occurrenceKey, occurrence);
    violations.push({ file: relFile, line: lineIndex + 1, occurrence, snippet, reason });
  };

  for (let i = 0; i < lines.length; i++) {
    const socketPayloadParam = socketHandlerPayloadParam(lines, i);
    if (socketPayloadParam && !validationNear(lines, i, socketPayloadParam)) {
      pushViolation(i, 'socket event payload is used without nearby Zod validation');
    }

    if (!/\bregisterSocketRpc\s*\(/.test(lines[i])) continue;
    const block = lines.slice(i, i + CALL_BLOCK_LINES).join('\n');
    const rpcPayloadParam = socketRpcPayloadParam(block);
    if (rpcPayloadParam && !registerSocketRpcValidated(block, rpcPayloadParam)) {
      pushViolation(i, 'socket RPC payload is accepted without payloadSchema or parser');
    }
  }

  return violations;
}

function violationKey(v: Violation): string {
  return `${v.file}\t#${v.occurrence}\t${v.snippet}\t${v.reason}`;
}

function collectViolations(opts: Pick<CheckOptions, 'root' | 'inputPaths'>): Violation[] {
  const files = opts.inputPaths.flatMap((path) => walk(join(opts.root, path)));
  return files.flatMap((file) => checkFile(file, opts.root));
}

function loadBaseline(baselinePath: string): Set<string> {
  if (!existsSync(baselinePath)) return new Set();
  return new Set(
    readFileSync(baselinePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#')),
  );
}

function writeBaseline(violations: Violation[], baselinePath: string): void {
  mkdirSync(dirname(baselinePath), { recursive: true });
  const sorted = violations.map(violationKey).sort();
  const header =
    '# socket boundary validation baseline - generated by `bun run fitness:socket-validation:refresh`\n' +
    '# Each line: <file>\\t<occurrence>\\t<normalized source line>\\t<reason>\n' +
    '# Scope: Socket.IO inbound handlers in packages/server/src/services/socketio and packages/runtime/src/services/team-client.ts.\n' +
    `# Last refreshed: ${new Date().toISOString()}\n` +
    `# Total violations: ${sorted.length}\n\n`;
  writeFileSync(baselinePath, header + sorted.join('\n') + (sorted.length > 0 ? '\n' : ''));
}

function findNewViolations(violations: Violation[], baseline: Set<string>): Violation[] {
  return violations.filter((v) => !baseline.has(violationKey(v)));
}

function runCheck(opts: CheckOptions): number {
  const violations = collectViolations(opts);

  if (REFRESH) {
    writeBaseline(violations, opts.baselinePath);
    console.log(`✓ Socket validation baseline refreshed: ${violations.length} violation(s) frozen`);
    console.log(`  ${opts.baselinePath}`);
    return 0;
  }

  const baseline = loadBaseline(opts.baselinePath);
  const newViolations = findNewViolations(violations, baseline);
  if (newViolations.length === 0) {
    console.log(
      `✓ No new unvalidated socket payload handlers (baseline: ${baseline.size}, current: ${violations.length})`,
    );
    return 0;
  }

  console.error(`\n✗ ${newViolations.length} new unvalidated socket payload handler(s):\n`);
  for (const violation of newViolations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.reason}`);
    console.error(`    ${violation.snippet}`);
  }
  console.error(
    '\n  Validate inbound socket payloads with parseSocketPayload(schema, data), a specific parse* helper, schema.safeParse(data), or registerSocketRpc payloadSchema.\n',
  );
  return 1;
}

function writeSocketFile(root: string, name: string, source: string): void {
  const socketDir = join(root, 'packages', 'server', 'src', 'services', 'socketio');
  mkdirSync(socketDir, { recursive: true });
  writeFileSync(join(socketDir, name), source.trimStart());
}

function runSelfTest(): void {
  const root = mkdtempSync(join(tmpdir(), 'funny-socket-boundary-validation-'));
  try {
    writeSocketFile(
      root,
      'validated.ts',
      `
      socket.on('runner:agent_event', (data: unknown) => {
        const msg = parseRunnerAgentEvent(data);
        return msg;
      });

      registerSocketRpc(socket, 'runner:heartbeat', {
        payloadSchema: runnerHeartbeatSchema,
        handler: async (_ctx, ack, data) => ack({ ok: data.activeThreadIds.length === 0 }),
      });
      `,
    );
    writeSocketFile(
      root,
      'new-debt.ts',
      `
      socket.on('runner:agent_event', (data: unknown) => {
        return data;
      });

      registerSocketRpc(socket, 'runner:assign_project', {
        handler: async (_ctx, ack, data) => ack({ ok: Boolean(data) }),
      });
      `,
    );

    const opts = {
      root,
      inputPaths: SOCKET_INPUT_PATHS,
      baselinePath: join(root, '.fitness', 'socket-boundary-validation-baseline.txt'),
    };
    const violations = collectViolations(opts);
    const keys = violations.map(violationKey).sort();
    assert.equal(violations.length, 2);
    assert(keys.some((key) => key.includes('socket event payload')));
    assert(keys.some((key) => key.includes('socket RPC payload')));

    writeBaseline(violations, opts.baselinePath);
    assert.equal(runCheck(opts), 0);

    writeSocketFile(
      root,
      'later-debt.ts',
      `
      socket.on('central:command', (raw: any) => {
        return raw;
      });
      `,
    );
    const newViolations = findNewViolations(
      collectViolations(opts),
      loadBaseline(opts.baselinePath),
    );
    assert.equal(newViolations.length, 1);
    assert.equal(newViolations[0]?.file, 'packages/server/src/services/socketio/later-debt.ts');
    console.log('✓ Socket boundary validation self-test passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  if (SELF_TEST) {
    runSelfTest();
    return;
  }
  process.exitCode = runCheck({
    root: ROOT,
    inputPaths: SOCKET_INPUT_PATHS,
    baselinePath: BASELINE_PATH,
  });
}

main();
