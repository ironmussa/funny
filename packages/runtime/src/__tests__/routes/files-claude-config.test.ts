/**
 * Regression tests for editing ~/.claude/settings.json via the internal editor.
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require('os') as typeof import('os');
  return { FAKE_HOME: pathMod.join(osMod.tmpdir(), `funny-claude-files-${Date.now()}`) };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => FAKE_HOME };
});

import filesRoutes from '../../routes/files.js';
import type { RuntimeServiceProvider } from '../../services/service-provider.js';
import { resetServices, setServices } from '../../services/service-registry.js';

describe('files routes — Claude home config', () => {
  let settingsPath: string;
  let app: Hono;

  beforeAll(() => {
    settingsPath = join(FAKE_HOME, '.claude', 'settings.json');

    const fakeServices = {
      projects: { listProjects: async (_userId: string) => [] },
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
      rmSync(FAKE_HOME, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('POST /write creates ~/.claude/settings.json when the directory is missing', async () => {
    const content = JSON.stringify({ env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } }, null, 2);
    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: settingsPath, content }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(settingsPath)).toBe(true);

    const readRes = await app.request(`/read?path=${encodeURIComponent(settingsPath)}`);
    expect(readRes.status).toBe(200);
    const body = (await readRes.json()) as { content: string };
    expect(body.content).toBe(content);
  });

  test('GET /read returns 404 when settings.json does not exist yet', async () => {
    const missing = join(FAKE_HOME, '.claude', 'settings.local.json');
    const res = await app.request(`/read?path=${encodeURIComponent(missing)}`);
    expect(res.status).toBe(404);
  });
});
