import { describe, expect, test } from 'vitest';

import { toCodexMcpConfig } from '../agents/codex-mcp.js';

describe('toCodexMcpConfig', () => {
  test('passes HTTP servers on, with the bearer token in the env, not the config', () => {
    const config = toCodexMcpConfig({
      funny_browser: {
        type: 'http',
        url: 'http://127.0.0.1:4100/mcp',
        headers: { Authorization: 'Bearer s3cret' },
      },
      docs: { type: 'http', url: 'https://docs.example/mcp' },
    });
    expect(config.mcpServers).toEqual({
      funny_browser: {
        url: 'http://127.0.0.1:4100/mcp',
        bearer_token_env_var: 'FUNNY_MCP_TOKEN_FUNNY_BROWSER',
      },
      docs: { url: 'https://docs.example/mcp' },
    });
    expect(config.env).toEqual({ FUNNY_MCP_TOKEN_FUNNY_BROWSER: 's3cret' });
    expect(JSON.stringify(config.mcpServers)).not.toContain('s3cret');
  });

  test('skips in-process and stdio servers', () => {
    expect(
      toCodexMcpConfig({
        funny: { type: 'sdk', instance: {} },
        local: { command: 'node', args: ['server.js'] },
      }),
    ).toEqual({ mcpServers: {}, env: {} });
    expect(toCodexMcpConfig(undefined)).toEqual({ mcpServers: {}, env: {} });
  });

  test('approveTools pre-approves the tools (SDK mode cannot prompt)', () => {
    const config = toCodexMcpConfig(
      { funny_browser: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
      { approveTools: true },
    );
    expect(config.mcpServers.funny_browser).toEqual({
      url: 'http://127.0.0.1:1/mcp',
      default_tools_approval_mode: 'approve',
    });
  });
});
