/**
 * The MCP bridge gives agents without an MCP client (LLM API, pi) the tools
 * of HTTP MCP servers: `mcp__<server>__<tool>` names, the server's JSON
 * Schema, text results, error flags, and instructions. Broken servers are
 * skipped; in-process servers are ignored.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';

import { connectMcpTools, mcpInstructionsBlock } from '../agents/mcp-tool-bridge.js';
import { piToolsFromMcp } from '../agents/pi-sdk.js';

let server: Server;
let url = '';
const seenAuth: string[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''));
    const mcp = new McpServer({ name: 'demo', version: '1.0.0' }, { instructions: 'Use echo.' });
    mcp.registerTool(
      'echo',
      { description: 'Echo text', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
    );
    mcp.registerTool('fail', { description: 'Always fails' }, async () => ({
      content: [{ type: 'text', text: 'nope' }],
      isError: true,
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('connectMcpTools', () => {
  test('bridges HTTP servers and skips broken and in-process ones', async () => {
    const bridge = await connectMcpTools({
      demo: { type: 'http', url, headers: { Authorization: 'Bearer t0k' } },
      broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
      inproc: { type: 'sdk', instance: {} },
    });
    try {
      expect(bridge.tools.map((t) => t.name).sort()).toEqual([
        'mcp__demo__echo',
        'mcp__demo__fail',
      ]);
      const echo = bridge.tools.find((t) => t.name === 'mcp__demo__echo')!;
      expect(echo.inputSchema).toMatchObject({
        type: 'object',
        properties: { text: { type: 'string' } },
      });
      expect(await echo.call({ text: 'hi' })).toEqual({ text: 'echo: hi', isError: false });
      const fail = bridge.tools.find((t) => t.name === 'mcp__demo__fail')!;
      expect(await fail.call({})).toEqual({ text: 'nope', isError: true });
      expect(seenAuth).toContain('Bearer t0k');
      expect(mcpInstructionsBlock(bridge.instructions)).toContain('### demo\nUse echo.');
    } finally {
      await bridge.close();
    }
  });

  test('no HTTP servers means no tools', async () => {
    const bridge = await connectMcpTools(undefined);
    expect(bridge.tools).toEqual([]);
    expect(mcpInstructionsBlock(bridge.instructions)).toBe('');
  });

  test('pi custom tools pass the schema through and throw on MCP errors', async () => {
    const bridge = await connectMcpTools({ demo: { type: 'http', url } });
    try {
      const tools = piToolsFromMcp(bridge);
      const echo = tools.find((t) => t.name === 'mcp__demo__echo')!;
      expect(echo.parameters).toMatchObject({ type: 'object' });
      expect(await echo.execute('c1', { text: 'pi' }, undefined)).toEqual({
        content: [{ type: 'text', text: 'echo: pi' }],
        details: undefined,
      });
      const fail = tools.find((t) => t.name === 'mcp__demo__fail')!;
      await expect(fail.execute('c2', {}, undefined)).rejects.toThrow('nope');
    } finally {
      await bridge.close();
    }
  });
});
