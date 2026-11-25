/**
 * funny's own MCP servers reach every agent the same way: loopback HTTP with
 * the thread's token. `funny` stays always-loaded; one token opens both
 * servers; unknown servers and foreign tokens are refused.
 */

import { afterAll, describe, expect, test, vi, mock } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
mock.module('../../services/service-registry.js', () => ({ getServices: vi.fn() }));
mock.module('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
mock.module('../../services/agent-job-manager.js', () => ({ spawnJob: vi.fn() }));
mock.module('../../services/agent-watcher-manager.js', () => ({ createOrReschedule: vi.fn() }));
mock.module('../../services/thread-manager.js', () => ({ getThread: vi.fn() }));
mock.module('../../services/thread-service/create.js', () => ({ createAndStartThread: vi.fn() }));

import { stopAgentMcpHttp } from '../../services/agent-mcp-http.js';
import {
  withBrowserMcpServer,
  withWatchMcpServer,
} from '../../services/agent-startup/agent-profile.js';
import { expectDefined } from '../helpers/builders-agents.js';

afterAll(() => stopAgentMcpHttp());

async function listTools(entry: { url: string; headers: Record<string, string> }) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: entry.headers },
    }),
  );
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe('funny MCP servers over HTTP', () => {
  test('Claude uses native jobs while retaining scheduled wakes and other tools', async () => {
    const watch = expectDefined(await withWatchMcpServer('native-jobs', 'u1', undefined, 'claude'));
    const all = expectDefined(await withBrowserMcpServer('native-jobs', 'u1', watch));
    expect((await listTools(all.funny)).sort()).toEqual([
      'funny_factory_control',
      'funny_factory_request_approval',
      'funny_factory_runs',
      'funny_run_checks',
      'funny_search_threads',
      'funny_spawn_thread',
      'funny_watch',
    ]);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(all.funny.url), {
        requestInit: { headers: all.funny.headers },
      }),
    );
    try {
      const result = await client.callTool({
        name: 'funny_spawn',
        arguments: { command: 'echo test' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  test('changing provider on a thread refreshes background job availability', async () => {
    for (const provider of ['claude', 'codex', 'claude'] as const) {
      const servers = expectDefined(
        await withWatchMcpServer('provider-switch', 'u1', undefined, provider),
      );
      const names = await listTools(servers.funny);
      expect(names.includes('funny_spawn')).toBe(provider !== 'claude');
      expect(names).toContain('funny_watch');
    }
  });

  test('the funny server is an always-loaded HTTP entry with its tools', async () => {
    const servers = expectDefined(await withWatchMcpServer('t1', 'u1', undefined));
    // A copy: bun's toMatchObject writes the asymmetric matchers into the object
    // it checks, which would replace `url` before listTools reads it.
    expect({ ...servers.funny }).toMatchObject({
      type: 'http',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/funny$/),
      alwaysLoad: true,
    });
    expect((await listTools(servers.funny)).sort()).toEqual([
      'funny_factory_control',
      'funny_factory_request_approval',
      'funny_factory_runs',
      'funny_run_checks',
      'funny_search_threads',
      'funny_spawn',
      'funny_spawn_thread',
      'funny_watch',
    ]);
  });

  test('one thread token opens both servers; unknown servers are not found', async () => {
    const watch = expectDefined(await withWatchMcpServer('t2', 'u1', undefined));
    const all = expectDefined(await withBrowserMcpServer('t2', 'u1', watch));
    expect(all.funny_browser.headers).toEqual(all.funny.headers);
    expect(await listTools(all.funny_browser)).toContain('browser_open');

    const unknown = await fetch(all.funny.url.replace(/\/funny$/, '/nope'), {
      method: 'POST',
      headers: all.funny.headers,
    });
    expect(unknown.status).toBe(404);
  });

  test("another thread's token is a different one", async () => {
    const a = expectDefined(await withWatchMcpServer('t3', 'u1', undefined));
    const b = expectDefined(await withWatchMcpServer('t4', 'u1', undefined));
    expect(a.funny.headers.Authorization).not.toBe(b.funny.headers.Authorization);
  });
});
