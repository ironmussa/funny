/**
 * Regression tests for files.ts symlink-escape protection (audit C2).
 *
 * The route resolves every user-supplied path through `realpath()` once, then
 * performs all I/O on the canonical path. A symlink swap between check and
 * use cannot escape the project scope.
 */

import { mkdirSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Hono } from 'hono';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import filesRoutes from '../../routes/files.js';
import type { RuntimeServiceProvider } from '../../services/service-provider.js';
import { setServices, resetServices } from '../../services/service-registry.js';

describe('files routes — symlink escape protection', () => {
  let projectDir: string;
  let outsideDir: string;
  let secretFile: string;
  let app: Hono;

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'funny-files-test-'));
    projectDir = join(tmp, 'project');
    outsideDir = join(tmp, 'outside');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    secretFile = join(outsideDir, 'secret.txt');
    writeFileSync(secretFile, 'TOP SECRET', 'utf-8');

    // A symlink inside the project that points OUTSIDE the project.
    symlinkSync(secretFile, join(projectDir, 'escape.txt'));

    const fakeServices = {
      projects: {
        listProjects: async (_userId: string) => [{ id: 'p1', name: 'p', path: projectDir }],
      },
    } as unknown as RuntimeServiceProvider;

    resetServices();
    setServices(fakeServices);

    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId' as never, 'user-1' as never);
      await next();
    });
    app.route('/', filesRoutes);
  });

  afterAll(() => {
    resetServices();
    try {
      rmSync(join(projectDir, '..'), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('GET /read denies a symlink that escapes the project scope', async () => {
    const escape = join(projectDir, 'escape.txt');
    const res = await app.request(`/read?path=${encodeURIComponent(escape)}`);
    expect(res.status).toBe(403);
  });

  test('POST /write denies a symlink that escapes the project scope', async () => {
    const escape = join(projectDir, 'escape.txt');
    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: escape, content: 'pwned' }),
    });
    expect(res.status).toBe(403);
  });

  test('GET /raw denies a symlink that escapes the project scope', async () => {
    const escape = join(projectDir, 'escape.txt');
    const res = await app.request(`/raw?path=${encodeURIComponent(escape)}`);
    expect(res.status).toBe(403);
  });

  test('GET /read allows a real file inside the project', async () => {
    const inside = join(projectDir, 'inside.txt');
    writeFileSync(inside, 'hello', 'utf-8');
    const res = await app.request(`/read?path=${encodeURIComponent(inside)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe('hello');
  });
});
