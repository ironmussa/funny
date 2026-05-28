/**
 * Tests for `toACPMcpServers` — converts funny's internal Claude-shaped MCP
 * server map (`{ name: { type?, command, args, env, url, headers } }`) into the
 * ACP `McpServer[]` shape expected by `session/new` / `session/load`.
 *
 * The conversion needs to be strict-zod-safe: ACP schemas reject entries with
 * missing `name` / `command` and treat `args` / `env` / `headers` as required
 * arrays, so we always emit defaults.
 */

import { describe, expect, test } from 'vitest';

import { toACPMcpServers } from '../agents/acp-mcp.js';

describe('toACPMcpServers', () => {
  test('undefined input → []', () => {
    expect(toACPMcpServers(undefined)).toEqual([]);
  });

  test('empty object → []', () => {
    expect(toACPMcpServers({})).toEqual([]);
  });

  test('stdio server: includes name, command, args, env (always)', () => {
    const out = toACPMcpServers({
      memory: { command: 'mcp-memory', args: ['--db', '/tmp/m'], env: { LOG: 'debug' } },
    });
    expect(out).toEqual([
      {
        name: 'memory',
        command: 'mcp-memory',
        args: ['--db', '/tmp/m'],
        env: [{ name: 'LOG', value: 'debug' }],
      },
    ]);
  });

  test('stdio server with no args/env → defaults to empty arrays', () => {
    const out = toACPMcpServers({
      bare: { command: 'mcp-bare' },
    });
    expect(out).toEqual([{ name: 'bare', command: 'mcp-bare', args: [], env: [] }]);
  });

  test('stdio server with missing command → empty string (zod requires the field)', () => {
    const out = toACPMcpServers({
      broken: { args: ['x'] },
    });
    expect(out).toEqual([{ name: 'broken', command: '', args: ['x'], env: [] }]);
  });

  test('http server: type=http, url, headers as pairs', () => {
    const out = toACPMcpServers({
      api: {
        type: 'http',
        url: 'https://api.example.com',
        headers: { Authorization: 'Bearer xyz' },
      },
    });
    expect(out).toEqual([
      {
        type: 'http',
        name: 'api',
        url: 'https://api.example.com',
        headers: [{ name: 'Authorization', value: 'Bearer xyz' }],
      },
    ]);
  });

  test('sse server: type=sse, url, headers as pairs', () => {
    const out = toACPMcpServers({
      events: { type: 'sse', url: 'https://stream.example.com' },
    });
    expect(out).toEqual([
      { type: 'sse', name: 'events', url: 'https://stream.example.com', headers: [] },
    ]);
  });

  test('type is normalized to lowercase before dispatch (HTTP → http)', () => {
    const out = toACPMcpServers({
      api: { type: 'HTTP', url: 'https://x' },
    });
    expect(out[0]).toMatchObject({ type: 'http', name: 'api' });
  });

  test('env provided as an array of {name,value} pairs is preserved', () => {
    const out = toACPMcpServers({
      svc: {
        command: 'mcp-svc',
        env: [
          { name: 'A', value: '1' },
          { name: 'B', value: '2' },
        ],
      },
    });
    expect(out[0]).toMatchObject({
      env: [
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
      ],
    });
  });

  test('env provided as an array with malformed entries drops the malformed ones', () => {
    const out = toACPMcpServers({
      svc: {
        command: 'mcp-svc',
        env: [{ name: 'A', value: '1' }, { something: 'else' }],
      },
    });
    expect(out[0]).toMatchObject({ env: [{ name: 'A', value: '1' }] });
  });

  test('numeric env values are coerced to strings', () => {
    const out = toACPMcpServers({
      svc: { command: 'mcp-svc', env: { PORT: 8080 } },
    });
    expect(out[0]).toMatchObject({ env: [{ name: 'PORT', value: '8080' }] });
  });

  test('null / non-object server entries are skipped', () => {
    const out = toACPMcpServers({
      good: { command: 'mcp-good' },
      bad: null,
      stringy: 'not-an-object',
    } as any);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'good' });
  });

  test('args defaults to [] when not an array', () => {
    const out = toACPMcpServers({
      svc: { command: 'mcp-svc', args: 'not-an-array' as unknown as string[] },
    });
    expect(out[0]).toMatchObject({ args: [] });
  });

  test('preserves insertion order across multiple servers', () => {
    const out = toACPMcpServers({
      a: { command: 'a-cmd' },
      b: { type: 'http', url: 'https://b' },
      c: { command: 'c-cmd' },
    });
    expect(out.map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });
});
