/**
 * A tool call is silent until its tool returns, and some run long (a
 * synchronous `funny_run_checks` takes up to 30 min). The listener disables
 * its idle cutoff for MCP requests (`server.timeout(req, 0)`): Bun versions
 * that cut a pending response at `idleTimeout` would otherwise drop the call.
 * (Bun 1.4 already waits for a pending response, so this guards the behaviour
 * across versions rather than reproducing a failure on the current one.)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, expect, test, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

process.env.FUNNY_AGENT_MCP_IDLE_TIMEOUT_S = '1';
const { grantAgentMcpHttp, stopAgentMcpHttp } = await import('../../services/agent-mcp-http.js');

afterAll(() => {
  stopAgentMcpHttp();
  delete process.env.FUNNY_AGENT_MCP_IDLE_TIMEOUT_S;
});

test('a tool call longer than the idle timeout still returns', async () => {
  const entry = grantAgentMcpHttp(
    {
      name: 'slow',
      instructions: '',
      tools: () => [
        {
          name: 'wait',
          description: 'waits',
          schema: {},
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            return { content: [{ type: 'text', text: 'done' }] };
          },
        },
      ],
    },
    { threadId: 'thread-slow', userId: 'user-1' },
  );
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: entry.headers },
    }),
  );
  try {
    const result = await client.callTool({ name: 'wait', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
  } finally {
    await client.close();
  }
}, 10_000);
