import { describe, test, expect } from 'bun:test';
/**
 * Static-analysis regression guard for runner isolation in project→runner
 * routing.
 *
 * Bug: `findRunnerForProject(projectId)` was called WITHOUT a userId in the
 * thread-start and browser-PTY paths. Without userId it returns ANY runner
 * assigned to the project — including another user's runner — which then gets
 * cached as the thread's runner and routes every request cross-tenant (the
 * data-handler then refuses `data:resolve_project_path`, breaking the thread for
 * collaborators). Every call MUST be scoped to the requesting user's runner.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

const SOURCES = ['routes/threads.ts', 'services/socketio/browser-pty.ts'] as const;

describe('runner isolation — project→runner routing', () => {
  for (const rel of SOURCES) {
    test(`${rel}: findRunnerForProject is always scoped to a user`, () => {
      const src = read(rel);
      // A single-argument call (no comma before the closing paren) would route
      // cross-tenant. Match calls like findRunnerForProject(projectId) with no
      // second argument and assert there are none.
      const singleArg = /findRunnerForProject\(\s*[A-Za-z0-9_.!]+\s*\)/g;
      const offenders = src.match(singleArg) ?? [];
      expect(offenders).toEqual([]);
      // And it IS called with userId as the second argument.
      expect(src).toMatch(/findRunnerForProject\(\s*[A-Za-z0-9_.!]+\s*,\s*userId\s*\)/);
    });
  }
});
