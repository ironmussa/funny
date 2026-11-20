/**
 * Regression tests for editing ~/.claude/settings.json via the internal editor.
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const { FAKE_HOME } = await vi.hoisted(async () => {
  const pathMod = await import('path');
  const osMod = await vi.importActual<typeof import('os')>('os');
  return { FAKE_HOME: pathMod.join(osMod.tmpdir(), `funny-claude-files-${Date.now()}`) };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => FAKE_HOME };
});

import filesRoutes from '../../routes/files.js';
import { resetServices, setServices } from '../../services/service-registry.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { createServiceProviderFake } from '../helpers/builders.js';

describe('files routes — Claude home config', () => {
  let settingsPath: string;
  let app: Hono<HonoEnv>;

  beforeAll(() => {
    settingsPath = join(FAKE_HOME, '.claude', 'settings.json');

    const fakeServices = createServiceProviderFake({
      projects: { listProjects: async (_userId: string) => [] },
    });

    resetServices();
    setServices(fakeServices);

    app = new Hono<HonoEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
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
    const body: { content: string } = await readRes.json();
    expect(body.content).toBe(content);
  });

  test('GET /read returns 404 when settings.json does not exist yet', async () => {
    const missing = join(FAKE_HOME, '.claude', 'settings.local.json');
    const res = await app.request(`/read?path=${encodeURIComponent(missing)}`);
    expect(res.status).toBe(404);
  });
});
