import { describe, expect, test } from 'vitest';

import { parseMcpListOutput } from '../../services/mcp-service.js';

describe('parseMcpListOutput', () => {
  test('parses stdio servers without explicit type', () => {
    const servers = parseMcpListOutput('codegraph: codegraph serve --mcp - ✓ Connected\n');
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('codegraph');
    expect(servers[0].type).toBe('stdio');
    expect(servers[0].command).toBe('codegraph');
  });

  test('parses claude.ai connector names with spaces', () => {
    const servers = parseMcpListOutput(
      'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✓ Connected\n',
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('claude.ai Google Drive');
    expect(servers[0].type).toBe('http');
    expect(servers[0].url).toBe('https://drivemcp.googleapis.com/mcp/v1');
    expect(servers[0].toggleable).toBe(false);
  });

  test('parses plugin MCP servers', () => {
    const servers = parseMcpListOutput('plugin:sentrux:sentrux: npx -y tool - ✓ Connected\n');
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('plugin:sentrux:sentrux');
    expect(servers[0].toggleable).toBe(false);
  });

  test('parses auth and disabled status markers', () => {
    const output = [
      'neon: https://mcp.neon.tech/mcp (HTTP) - ! Needs authentication',
      'supabase: npx -y mcp-supabase - disabled',
    ].join('\n');

    const servers = parseMcpListOutput(output);
    expect(servers).toHaveLength(2);
    expect(servers[0].status).toBe('needs_auth');
    expect(servers[1].disabled).toBe(true);
  });

  test('skips health-check header lines', () => {
    const output = [
      'Checking MCP server health…',
      'codegraph: codegraph serve --mcp - ✓ Connected',
    ].join('\n');

    const servers = parseMcpListOutput(output);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('codegraph');
  });
});
