import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import { callerAddress, clientIp, parseTrustedProxyHops } from '../../lib/client-ip.js';

function probe(trustedHops: number) {
  const app = new Hono();
  app.get('*', (c) => c.json({ ip: clientIp(c, trustedHops) }));
  return async (headers: Record<string, string>, env?: unknown) => {
    const body: { ip: string | null } = await (await app.request('/', { headers }, env)).json();
    return body.ip;
  };
}

describe('clientIp', () => {
  test('reads the peer address the host supplies', async () => {
    expect(await probe(0)({}, { IP: { address: '203.0.113.7' } })).toBe('203.0.113.7');
  });

  test('ignores X-Forwarded-For unless TRUST_PROXY', async () => {
    const ip = probe(0);
    expect(await ip({ 'x-forwarded-for': '1.1.1.1' }, { IP: { address: '203.0.113.7' } })).toBe(
      '203.0.113.7',
    );
    expect(await ip({ 'x-forwarded-for': '1.1.1.1' })).toBeNull();
  });

  test('takes the right-most X-Forwarded-For hop behind one trusted proxy', async () => {
    const ip = probe(1);
    expect(await ip({ 'x-forwarded-for': '1.1.1.1' }, { IP: { address: '10.0.0.2' } })).toBe(
      '1.1.1.1',
    );
    // A client-supplied `X-Forwarded-For: 6.6.6.6` gets the real address
    // appended by the proxy: the forged left-most hop must not win.
    expect(
      await ip({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }, { IP: { address: '10.0.0.2' } }),
    ).toBe('1.1.1.1');
    expect(await ip({}, { IP: { address: '10.0.0.2' } })).toBe('10.0.0.2');
  });

  test('null when nothing identifies the caller', async () => {
    expect(await probe(0)({})).toBeNull();
    expect(await probe(0)({}, { IP: null })).toBeNull();
  });
});

describe('callerAddress (raw requests, e.g. the runner carrier)', () => {
  const forwarded = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });

  test('uses the hop the outermost trusted proxy saw', () => {
    expect(callerAddress(forwarded, '10.0.0.2', 2)).toBe('203.0.113.7');
    expect(callerAddress(forwarded, '10.0.0.2', 1)).toBe('10.0.0.1');
  });

  test('ignores hops forged to the left of the trusted proxies', () => {
    const spoofed = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.1' });
    expect(callerAddress(spoofed, '10.0.0.2', 2)).toBe('203.0.113.7');
  });

  test('takes the left-most hop when there are fewer hops than trusted proxies', () => {
    expect(callerAddress(forwarded, '10.0.0.2', 5)).toBe('203.0.113.7');
  });

  test('skips empty hops', () => {
    const sloppy = new Headers({ 'x-forwarded-for': '203.0.113.7, ,' });
    expect(callerAddress(sloppy, '10.0.0.2', 1)).toBe('203.0.113.7');
    expect(callerAddress(new Headers({ 'x-forwarded-for': ' , ' }), '10.0.0.2', 1)).toBe(
      '10.0.0.2',
    );
  });

  test('keeps the peer when proxy headers are not trusted', () => {
    expect(callerAddress(forwarded, '10.0.0.2', 0)).toBe('10.0.0.2');
  });

  test('null when nothing identifies the caller', () => {
    expect(callerAddress(new Headers(), undefined, 0)).toBeNull();
  });
});

describe('parseTrustedProxyHops (TRUST_PROXY)', () => {
  test('true is one hop, an integer is that many', () => {
    expect(parseTrustedProxyHops('true')).toBe(1);
    expect(parseTrustedProxyHops('TRUE')).toBe(1);
    expect(parseTrustedProxyHops('2')).toBe(2);
  });

  test('anything else trusts no proxy', () => {
    for (const raw of [undefined, '', 'false', '0', '-1', '1.5', 'yes']) {
      expect(parseTrustedProxyHops(raw)).toBe(0);
    }
  });
});
