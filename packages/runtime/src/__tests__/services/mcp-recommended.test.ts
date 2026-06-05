import { describe, expect, test } from 'vitest';

import { RECOMMENDED_SERVERS } from '../../services/mcp-service.js';

describe('RECOMMENDED_SERVERS', () => {
  test('includes Neon hosted MCP server', () => {
    const neon = RECOMMENDED_SERVERS.find((s) => s.name === 'neon');
    expect(neon).toBeDefined();
    expect(neon?.type).toBe('http');
    expect(neon?.url).toBe('https://mcp.neon.tech/mcp');
  });

  test('includes Cloudflare API MCP server', () => {
    const cloudflare = RECOMMENDED_SERVERS.find((s) => s.name === 'cloudflare');
    expect(cloudflare).toBeDefined();
    expect(cloudflare?.type).toBe('http');
    expect(cloudflare?.url).toBe('https://mcp.cloudflare.com/mcp');
  });

  test('includes Linear hosted MCP server', () => {
    const linear = RECOMMENDED_SERVERS.find((s) => s.name === 'linear');
    expect(linear).toBeDefined();
    expect(linear?.type).toBe('http');
    expect(linear?.url).toBe('https://mcp.linear.app/mcp');
  });
});
