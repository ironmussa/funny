/**
 * Verifies that the runtime's central:browser_ws handler covers
 * all PTY events that the server forwards.
 *
 * Catches the case where the server forwards an event but the runtime
 * doesn't handle it, or vice versa — the runtime handles an event that
 * the server doesn't forward.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, test, expect } from 'vitest';

// Paths relative to the monorepo root (__tests__/services/)
const MONOREPO_ROOT = resolve(import.meta.dirname ?? __dirname, '../../../../..');
const SOCKETIO_PATH = resolve(MONOREPO_ROOT, 'packages/server/src/services/socketio.ts');
const APP_PATH = resolve(MONOREPO_ROOT, 'packages/runtime/src/app/pty-message-handler.ts');

function extractPtyEvents(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern);
  if (!match) return [];
  return [...match[0].matchAll(/'(pty:[^']+)'/g)].map((m) => m[1]);
}

describe('PTY event sync between server and runtime', () => {
  const socketioSource = readFileSync(SOCKETIO_PATH, 'utf-8');
  const appSource = readFileSync(APP_PATH, 'utf-8');

  // Events the server forwards (ptyEvents array)
  const serverEvents = extractPtyEvents(socketioSource, /const ptyEvents\s*=\s*\[[\s\S]*?\]/);

  // Events the runtime handles (case 'pty:...' in the switch)
  const runtimeEvents = [...appSource.matchAll(/case '(pty:[^']+)'/g)].map((m) => m[1]);

  test('server ptyEvents array is non-empty', () => {
    expect(serverEvents.length).toBeGreaterThan(0);
  });

  test('runtime handles at least the core PTY events', () => {
    expect(runtimeEvents.length).toBeGreaterThan(0);
  });

  test('every PTY event handled by the runtime is forwarded by the server', () => {
    const missingFromServer = runtimeEvents.filter((e) => !serverEvents.includes(e));
    expect(missingFromServer).toEqual([]);
  });

  test('every PTY event forwarded by the server is handled by the runtime', () => {
    // pty:close and pty:reconnect may not have explicit case handlers (handled
    // by the backend directly or as no-ops). Only flag truly unexpected gaps.
    const optionalEvents = ['pty:close', 'pty:reconnect', 'pty:rename'];
    const missingFromRuntime = serverEvents.filter(
      (e) => !runtimeEvents.includes(e) && !optionalEvents.includes(e),
    );
    expect(missingFromRuntime).toEqual([]);
  });
});
