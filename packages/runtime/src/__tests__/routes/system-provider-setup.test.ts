import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveProfile: vi.fn(),
  setupStatus: vi.fn(),
  startInstall: vi.fn(),
  providerKey: vi.fn(),
}));

vi.mock('@funny/core/git', () => ({ getNativeGit: vi.fn() }));
vi.mock('../../lib/data-dir.js', () => ({ DATA_DIR: '/tmp/provider-route-test' }));
vi.mock('../../lib/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: {} }));
vi.mock('../../utils/claude-binary.js', () => ({ resetBinaryCache: vi.fn() }));
vi.mock('../../utils/provider-detection.js', () => ({
  getAvailableProviders: vi.fn(),
  resetProviderCache: vi.fn(),
}));
vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    profile: { getProviderKey: mocks.providerKey },
    agentProfiles: { resolveEffectiveProfile: mocks.resolveProfile },
  }),
}));
vi.mock('../../services/provider-setup.js', () => ({
  isInstallableProvider: (provider: string) => ['claude', 'codex'].includes(provider),
  providerSetupStatus: mocks.setupStatus,
  startProviderInstall: mocks.startInstall,
}));

import { registerSystemRoutes } from '../../app/system-routes.js';
import type { HonoEnv } from '../../types/hono-env.js';

function createApp(authenticated = true) {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    if (authenticated) c.set('userId', 'user-1');
    await next();
  });
  registerSystemRoutes(app);
  return app;
}

describe('provider setup routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerKey.mockResolvedValue(null);
    mocks.resolveProfile.mockResolvedValue({
      profile: { provider: 'claude' },
      env: { CLAUDE_CONFIG_DIR: '~/.claude-goliiive' },
    });
    mocks.setupStatus.mockResolvedValue({ provider: 'claude', auth: 'required' });
    mocks.startInstall.mockReturnValue(true);
  });

  it.each(['GET', 'POST'])('%s uses the authenticated user’s project profile', async (method) => {
    const res = await createApp().request(
      '/api/system/providers/claude/setup?projectId=project-1',
      {
        method,
      },
    );
    expect(res.status).toBe(method === 'GET' ? 200 : 202);
    expect(mocks.resolveProfile).toHaveBeenCalledWith('project-1', 'user-1');
    expect(mocks.setupStatus).toHaveBeenCalledWith('claude', false, {
      claudeConfigDir: '~/.claude-goliiive',
    });
  });

  it.each([
    ['claude', ''],
    ['codex', '?projectId=project-1'],
  ])('preserves default setup for %s without a Claude profile', async (provider, query) => {
    const res = await createApp().request(`/api/system/providers/${provider}/setup${query}`);
    expect(res.status).toBe(200);
    expect(mocks.resolveProfile).not.toHaveBeenCalled();
    expect(mocks.setupStatus).toHaveBeenCalledWith(provider, false, {});
  });

  it.each(['GET', 'POST'])(
    '%s rejects unauthenticated setup before resolving profiles',
    async (method) => {
      const res = await createApp(false).request(
        '/api/system/providers/claude/setup?projectId=project-1',
        {
          method,
        },
      );
      expect(res.status).toBe(401);
      expect(mocks.resolveProfile).not.toHaveBeenCalled();
      expect(mocks.setupStatus).not.toHaveBeenCalled();
      expect(mocks.startInstall).not.toHaveBeenCalled();
    },
  );
});
