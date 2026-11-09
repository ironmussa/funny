import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import { clientIp } from '../../lib/client-ip.js';

function probe(trustProxy: boolean) {
  const app = new Hono();
  app.get('*', (c) => c.json({ ip: clientIp(c, trustProxy) }));
  return async (headers: Record<string, string>, env?: unknown) =>
    ((await (await app.request('/', { headers }, env)).json()) as { ip: string | null }).ip;
}

describe('clientIp', () => {
  test('reads the peer address the host supplies', async () => {
    expect(await probe(false)({}, { IP: { address: '203.0.113.7' } })).toBe('203.0.113.7');
  });

  test('ignores X-Forwarded-For unless TRUST_PROXY', async () => {
    const ip = probe(false);
    expect(await ip({ 'x-forwarded-for': '1.1.1.1' }, { IP: { address: '203.0.113.7' } })).toBe(
      '203.0.113.7',
    );
    expect(await ip({ 'x-forwarded-for': '1.1.1.1' })).toBeNull();
  });

  test('takes the first X-Forwarded-For hop behind a trusted proxy', async () => {
    const ip = probe(true);
    expect(
      await ip({ 'x-forwarded-for': '1.1.1.1, 10.0.0.1' }, { IP: { address: '10.0.0.2' } }),
    ).toBe('1.1.1.1');
    expect(await ip({}, { IP: { address: '10.0.0.2' } })).toBe('10.0.0.2');
  });

  test('null when nothing identifies the caller', async () => {
    expect(await probe(false)({})).toBeNull();
    expect(await probe(false)({}, { IP: null })).toBeNull();
  });
});
