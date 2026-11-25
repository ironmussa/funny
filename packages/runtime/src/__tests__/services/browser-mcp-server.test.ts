/**
 * The funny_browser server reaches every agent over loopback HTTP, honours
 * the kill switch, and carries the agent instructions. The endpoint only
 * answers a thread's token.
 */

import { afterAll, afterEach, describe, expect, test, vi, mock } from 'bun:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
mock.module('../../services/service-registry.js', () => ({ getServices: vi.fn() }));
mock.module('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

import { revokeAgentMcpHttp, stopAgentMcpHttp } from '../../services/agent-mcp-http.js';
import { withBrowserMcpServer } from '../../services/agent-startup/agent-profile.js';
import {
  BROWSER_INSTRUCTIONS,
  BROWSER_MCP_SERVER_NAME,
} from '../../services/browser-automation/browser-mcp-server.js';
import { expectDefined, expectHttpMcpEntry } from '../helpers/builders-agents.js';

afterAll(() => stopAgentMcpHttp());

async function connect(entry: { url: string; headers: Record<string, string> }) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: entry.headers },
    }),
  );
  return client;
}

describe('withBrowserMcpServer', () => {
  afterEach(() => {
    delete process.env.FUNNY_BROWSER_TOOLS;
  });

  test('every agent gets the server over loopback HTTP with a bearer token, keeping other servers', async () => {
    const servers = await withBrowserMcpServer('t1', 'u1', { funny: { command: 'funny' } });
    expect(Object.keys(servers ?? {})).toEqual(['funny', BROWSER_MCP_SERVER_NAME]);
    const entry = expectDefined(servers)[BROWSER_MCP_SERVER_NAME];
    expect(entry).toMatchObject({
      type: 'http',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/funny_browser$/),
    });
    expect(expectHttpMcpEntry(entry).headers.Authorization).toMatch(/^Bearer \S{40,}$/);
  });

  test('skips spawns without a user', async () => {
    expect(await withBrowserMcpServer('t1', undefined, undefined)).toBeUndefined();
  });

  test('FUNNY_BROWSER_TOOLS=0 disables the server', async () => {
    process.env.FUNNY_BROWSER_TOOLS = '0';
    const servers = await withBrowserMcpServer('t1', 'u1', {});
    expect(servers).toEqual({});
  });

  test('instructions explain refs, the panel and when to hand over to the user', () => {
    expect(BROWSER_INSTRUCTIONS).toContain('browser_snapshot');
    expect(BROWSER_INSTRUCTIONS).toContain('stale-ref');
    expect(BROWSER_INSTRUCTIONS).toContain('browser panel');
    expect(BROWSER_INSTRUCTIONS).toContain('CAPTCHA');
  });
});

describe('funny_browser over HTTP', () => {
  test("lists the browser tools and runs them for the token's thread", async () => {
    const servers = await withBrowserMcpServer('t-http', 'u1', undefined);
    const client = await connect(
      expectHttpMcpEntry(expectDefined(servers)[BROWSER_MCP_SERVER_NAME]),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          'browser_open',
          'browser_snapshot',
          'browser_act',
          'browser_close',
        ]),
      );
      expect(client.getInstructions()).toBe(BROWSER_INSTRUCTIONS);
      // No session yet for this thread: the tool answers with its error code.
      const result: any = await client.callTool({ name: 'browser_status', arguments: {} });
      expect(result.content[0].text).toMatch(/No browser session is open for this thread/);
    } finally {
      await client.close();
    }
  });

  test('refuses requests without a valid token or with a revoked one', async () => {
    const first = expectDefined(await withBrowserMcpServer('t-rot', 'u1', undefined));
    const entry = expectHttpMcpEntry(first[BROWSER_MCP_SERVER_NAME]);
    const post = (headers: Record<string, string>) =>
      fetch(entry.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: 'Bearer nope' })).status).toBe(401);

    // Spawns of the same thread share the token (agent reuse compares it)…
    const again = expectDefined(await withBrowserMcpServer('t-rot', 'u1', undefined));
    expect(expectHttpMcpEntry(again[BROWSER_MCP_SERVER_NAME]).headers).toEqual(entry.headers);
    expect((await post(entry.headers)).status).toBe(200);

    // …until the thread is deleted.
    revokeAgentMcpHttp('t-rot');
    expect((await post(entry.headers)).status).toBe(401);
  });
});
