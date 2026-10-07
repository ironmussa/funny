#!/usr/bin/env bun
/**
 * Fitness function: runner-request isolation sinks (runner-request-isolation).
 *
 * Every server → runner request must go through `services/runner-access`
 * (`AuthorizedRunnerRequests` / `AuthorizedRunnerTerminal`), which demands a
 * `RunnerFor` proof and signs the identity itself. This check fails when
 * production code in `packages/server/src`:
 *
 *  - calls `.request(` on a runner-request port, or `.dispatch(` /
 *    `.listSessions(` on a terminal port, outside `services/runner-access/`
 *    and the gRPC adapters (`services/grpc/`);
 *  - calls `sendDelegated(` (steer-share delegation) outside `middleware/proxy.ts`;
 *  - calls `createRunnerAccess(` (injectable prover deps) outside
 *    `services/runner-access/`.
 *
 * Tests (`__tests__`) are exempt. `ALLOWLIST` names files that have not been
 * migrated yet; it must end empty. Exits non-zero on violation.
 * `--self-test` checks the allowed/forbidden fixtures.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SERVER_SRC = 'packages/server/src';

/** Files allowed to touch the raw ports: the authorized sinks and the gRPC adapters. */
const RAW_PORT_ALLOWED_DIRS = [
  `${SERVER_SRC}/services/runner-access/`,
  `${SERVER_SRC}/services/grpc/`,
];
const DELEGATION_ALLOWED_FILES = [`${SERVER_SRC}/middleware/proxy.ts`];
const RUNNER_ACCESS_FACTORY_ALLOWED_DIRS = [`${SERVER_SRC}/services/runner-access/`];

/** Not-yet-migrated sinks. Remove each file as it moves to the authorized port. */
const ALLOWLIST = new Set<string>([]);

interface Rule {
  name: string;
  pattern: RegExp;
  allowedDirs?: string[];
  allowedFiles?: string[];
}

const RULES: Rule[] = [
  {
    name: 'raw runner request (use AuthorizedRunnerRequests.send)',
    // `<something>requests.request(`, `runnerRequests!.request(`, `port.request(`…
    // Also a chained call that starts its own line (`dependencies.requests\n  .request(`).
    pattern:
      /\b(?:[A-Za-z_$][\w$]*!?\??\.)*(?:[a-zA-Z]*[Rr]equests|runnerRequests|requestPort|port|transport)!?\??\.request\(|^\s*\.request\(/,
    allowedDirs: RAW_PORT_ALLOWED_DIRS,
  },
  {
    name: 'raw terminal dispatch (use AuthorizedRunnerTerminal)',
    pattern:
      /\b(?:[A-Za-z_$][\w$]*!?\??\.)*(?:[a-zA-Z]*[Tt]erminals|runnerTerminals|terminalPort|port|dispatcher)!?\??\.(?:dispatch|listSessions)\(|^\s*\.(?:dispatch|listSessions)\(/,
    allowedDirs: RAW_PORT_ALLOWED_DIRS,
  },
  {
    name: 'steer delegation send outside middleware/proxy.ts',
    pattern: /\.sendDelegated\(/,
    allowedFiles: DELEGATION_ALLOWED_FILES,
  },
  {
    name: 'runner-access factory outside services/runner-access',
    pattern: /\bcreateRunnerAccess\(/,
    allowedDirs: RUNNER_ACCESS_FACTORY_ALLOWED_DIRS,
  },
];

function isAllowed(rule: Rule, file: string): boolean {
  if (rule.allowedDirs?.some((dir) => file.startsWith(dir))) return true;
  if (rule.allowedFiles?.includes(file)) return true;
  return false;
}

/** Violations for one source file (repo-relative path). */
export function classify(file: string, source: string): string[] {
  const violations: string[] = [];
  const lines = source.split('\n');
  for (const rule of RULES) {
    if (isAllowed(rule, file)) continue;
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
      if (rule.pattern.test(line)) violations.push(`${file}:${index + 1}: ${rule.name}`);
    });
  }
  return violations;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

function runSelfTest(): void {
  const grpc = `${SERVER_SRC}/services/grpc/runner-request-adapter.ts`;
  const sink = `${SERVER_SRC}/services/runner-access/authorized-runner-requests.ts`;
  const route = `${SERVER_SRC}/routes/example.ts`;
  const proxy = `${SERVER_SRC}/middleware/proxy.ts`;
  const allowed: Array<[string, string]> = [
    [grpc, 'exchange = this.dispatcher.dispatch(runnerId, dispatchRequest);'],
    [sink, 'return this.port.request(runnerId, { method, path, headers });'],
    [sink, 'this.port.dispatch(runner.value, actor.value.userId, event);'],
    [proxy, 'await sink.sendDelegated(owner, runner, proof, delegation, request);'],
    [
      `${SERVER_SRC}/services/runner-access/runner-for.ts`,
      'export const runnerAccess = createRunnerAccess();',
    ],
    [route, '// requests.request(runnerId, …) — commented out'],
    [route, 'const response = await app.request(path, { method: "GET" });'],
    [route, 'const body = await c.req.json();'],
    [route, 'await sink.send(actor, runner, proof, { method: "POST", path });'],
  ];
  const forbidden: Array<[string, string, string]> = [
    [
      route,
      'await requests.request(runnerId, { method, path, headers, body });',
      'raw runner request',
    ],
    [route, 'await dependencies.requests.request(runnerId, request);', 'raw runner request'],
    [
      route,
      'response = await c.env.runnerRequests!.request(runnerId, payload);',
      'raw runner request',
    ],
    [route, 'dependencies.terminals.dispatch(runnerId, userId, event);', 'raw terminal dispatch'],
    [
      route,
      'sessions: dependencies.terminals?.listSessions(runnerId, userId),',
      'raw terminal dispatch',
    ],
    [route, '    .listSessions(runnerId, principalUserId)', 'raw terminal dispatch'],
    [route, '      .request(runnerId, request);', 'raw runner request'],
    [
      route,
      'await sink.sendDelegated(owner, runner, proof, delegation, request);',
      'steer delegation',
    ],
    [
      `${SERVER_SRC}/services/socketio/browser-pty.ts`,
      'const access = createRunnerAccess({});',
      'runner-access factory',
    ],
  ];
  for (const [file, line] of allowed) {
    const v = classify(file, line);
    if (v.length)
      throw new Error(`self-test: expected no violation for ${file}: ${line}\n${v.join('\n')}`);
  }
  for (const [file, line, rule] of forbidden) {
    const v = classify(file, line);
    if (!v.some((m) => m.includes(rule))) {
      throw new Error(
        `self-test: expected "${rule}" violation for ${file}: ${line}\n${v.join('\n')}`,
      );
    }
  }
  console.log('runner request sinks self-test ok');
}

function main(): void {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const dir = join(ROOT, SERVER_SRC);
  if (!existsSync(dir)) throw new Error(`missing ${SERVER_SRC}`);
  const violations: string[] = [];
  const allowlistHits = new Set<string>();
  for (const abs of walk(dir)) {
    const file = relative(ROOT, abs);
    const found = classify(file, readFileSync(abs, 'utf8'));
    if (!found.length) continue;
    if (ALLOWLIST.has(file)) {
      allowlistHits.add(file);
      continue;
    }
    violations.push(...found);
  }
  const stale = [...ALLOWLIST].filter((f) => !allowlistHits.has(f));
  if (stale.length) {
    console.error(
      `runner request sinks: ALLOWLIST entries no longer needed:\n  ${stale.join('\n  ')}`,
    );
  }
  if (violations.length) {
    console.error(
      `runner request sinks: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`,
    );
    process.exit(1);
  }
  if (stale.length) process.exit(1);
  console.log(
    ALLOWLIST.size
      ? `runner request sinks ok — ${ALLOWLIST.size} file(s) still on the migration allow-list`
      : 'runner request sinks ok — every server → runner send goes through services/runner-access',
  );
}

main();
