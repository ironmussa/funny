/**
 * The funny_browser server is injected for Claude spawns only, honours the
 * kill switch, and carries the agent instructions.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/service-registry.js', () => ({ getServices: vi.fn() }));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

import { withBrowserMcpServer } from '../../services/agent-startup/agent-profile.js';
import {
  BROWSER_INSTRUCTIONS,
  BROWSER_MCP_SERVER_NAME,
} from '../../services/browser-automation/browser-mcp-server.js';

describe('withBrowserMcpServer', () => {
  afterEach(() => {
    delete process.env.FUNNY_BROWSER_TOOLS;
  });

  test('adds funny_browser for Claude spawns and keeps other servers', async () => {
    const servers = await withBrowserMcpServer('t1', 'u1', 'claude', { funny: { type: 'sdk' } });
    expect(Object.keys(servers ?? {})).toEqual(['funny', BROWSER_MCP_SERVER_NAME]);
    expect((servers as any)[BROWSER_MCP_SERVER_NAME].type).toBe('sdk');
  });

  test('skips other providers', async () => {
    const servers = await withBrowserMcpServer('t1', 'u1', 'codex', { funny: {} });
    expect(Object.keys(servers ?? {})).toEqual(['funny']);
  });

  test('skips spawns without a user', async () => {
    expect(await withBrowserMcpServer('t1', undefined, 'claude', undefined)).toBeUndefined();
  });

  test('FUNNY_BROWSER_TOOLS=0 disables the server', async () => {
    process.env.FUNNY_BROWSER_TOOLS = '0';
    const servers = await withBrowserMcpServer('t1', 'u1', 'claude', {});
    expect(servers).toEqual({});
  });

  test('instructions explain refs, the panel and when to hand over to the user', () => {
    expect(BROWSER_INSTRUCTIONS).toContain('browser_snapshot');
    expect(BROWSER_INSTRUCTIONS).toContain('stale-ref');
    expect(BROWSER_INSTRUCTIONS).toContain('browser panel');
    expect(BROWSER_INSTRUCTIONS).toContain('CAPTCHA');
  });
});
