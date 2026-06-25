import { Hono } from 'hono';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

const {
  mockAddMcpServer,
  mockListMcpServers,
  mockRemoveMcpServer,
  mockRequireProjectPath,
  mockResolveEffectiveProfile,
  mockStartOAuthFlow,
  mockToggleMcpServer,
} = vi.hoisted(() => ({
  mockAddMcpServer: vi.fn(),
  mockListMcpServers: vi.fn(),
  mockRemoveMcpServer: vi.fn(),
  mockRequireProjectPath: vi.fn(),
  mockResolveEffectiveProfile: vi.fn(),
  mockStartOAuthFlow: vi.fn(),
  mockToggleMcpServer: vi.fn(),
}));

vi.mock('../../services/mcp-service.js', () => ({
  addMcpServer: mockAddMcpServer,
  listMcpServers: mockListMcpServers,
  removeMcpServer: mockRemoveMcpServer,
  toggleMcpServer: mockToggleMcpServer,
  RECOMMENDED_SERVERS: [],
}));

vi.mock('../../lib/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../services/mcp-oauth.js', () => ({
  handleOAuthCallback: vi.fn(),
  startOAuthFlow: mockStartOAuthFlow,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    agentProfiles: {
      resolveEffectiveProfile: mockResolveEffectiveProfile,
    },
  }),
}));

vi.mock('../../utils/path-scope.js', () => ({
  requireProjectPath: mockRequireProjectPath,
}));

import mcpApp from '../../routes/mcp.js';

function makeApp(userId = 'user-1') {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/mcp', mcpApp);
  return app;
}

describe('MCP routes', () => {
  beforeEach(() => {
    mockAddMcpServer.mockReset().mockReturnValue(okAsync(undefined));
    mockListMcpServers.mockReset().mockReturnValue(okAsync([]));
    mockRemoveMcpServer.mockReset().mockReturnValue(okAsync(undefined));
    mockRequireProjectPath.mockReset().mockResolvedValue(null);
    mockResolveEffectiveProfile.mockReset().mockResolvedValue({
      profile: { id: 'profile-1', provider: 'claude' },
      env: { CLAUDE_CONFIG_DIR: '/tmp/claude-work' },
    });
    mockStartOAuthFlow.mockReset().mockReturnValue(okAsync({ authUrl: 'https://auth.test' }));
    mockToggleMcpServer.mockReset().mockReturnValue(okAsync(undefined));
  });

  test('GET /servers passes profile-specific Claude config to the MCP service', async () => {
    const app = makeApp();

    const res = await app.request(
      '/mcp/servers?projectPath=%2Frepo&provider=claude&projectId=project-1',
    );

    expect(res.status).toBe(200);
    expect(mockRequireProjectPath).toHaveBeenCalledWith('/repo', 'user-1');
    expect(mockResolveEffectiveProfile).toHaveBeenCalledWith('project-1', 'user-1');
    expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'claude', {
      claudeConfigDir: '/tmp/claude-work',
    });
  });

  test('POST /servers adds a server using the project Claude profile', async () => {
    const app = makeApp();

    const res = await app.request('/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ctx7',
        type: 'stdio',
        command: 'ctx7',
        projectPath: '/repo',
        projectId: 'project-1',
      }),
    });

    expect(res.status).toBe(200);
    expect(mockAddMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ctx7',
        provider: 'claude',
        projectPath: '/repo',
        projectId: 'project-1',
        claudeConfigDir: '/tmp/claude-work',
      }),
    );
  });

  test('POST /oauth/start uses the same profile for list and OAuth state', async () => {
    const app = makeApp();
    mockListMcpServers.mockReturnValue(
      okAsync([
        {
          name: 'linear',
          type: 'http',
          url: 'https://mcp.linear.test/mcp',
          source: 'user',
        },
      ]),
    );

    const res = await app.request('/mcp/oauth/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'app.example.test',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({
        serverName: 'linear',
        projectPath: '/repo',
        projectId: 'project-1',
        provider: 'claude',
      }),
    });

    expect(res.status).toBe(200);
    expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'claude', {
      claudeConfigDir: '/tmp/claude-work',
    });
    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      'linear',
      'https://mcp.linear.test/mcp',
      '/repo',
      'https://app.example.test',
      { claudeConfigDir: '/tmp/claude-work' },
    );
  });
});
