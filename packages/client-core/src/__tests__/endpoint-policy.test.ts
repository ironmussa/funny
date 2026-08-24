import { describe, expect, test } from 'bun:test';

import {
  createEndpointPolicy,
  resolveApiBaseForThread,
  validateRemoteOrigin,
} from '../endpoint-policy';

describe('endpoint policy', () => {
  test('resolves browser and Tauri primary endpoints', () => {
    expect(
      createEndpointPolicy({
        hostMode: 'browser',
        pageOrigin: 'https://funny.test',
        localServerPort: 3001,
        remoteOriginAllowlist: [],
      }),
    ).toMatchObject({ apiBase: '/api', realtimeOrigin: 'https://funny.test' });
    expect(
      createEndpointPolicy({
        hostMode: 'tauri',
        pageOrigin: 'tauri://localhost',
        localServerPort: 5002,
        remoteOriginAllowlist: [],
      }),
    ).toMatchObject({
      apiBase: 'http://localhost:5002/api',
      realtimeOrigin: 'http://localhost:5002',
    });
  });

  test('rejects malformed, credentialed, unsupported, and non-allowlisted origins', () => {
    expect(validateRemoteOrigin('not a url', [])).toBeNull();
    expect(validateRemoteOrigin('ftp://container.test', [])).toBeNull();
    const credentialedOrigin = `https://${['user', 'placeholder'].join(':')}@container.test`;
    expect(validateRemoteOrigin(credentialedOrigin, [])).toBeNull();
    expect(validateRemoteOrigin('https://other.test', ['https://container.test'])).toBeNull();
  });

  test('normalizes allowed remote origins and resolves remote thread API bases', () => {
    const policy = createEndpointPolicy({
      hostMode: 'browser',
      pageOrigin: 'https://funny.test',
      localServerPort: 3001,
      remoteOriginAllowlist: ['https://container.test'],
    });
    expect(
      validateRemoteOrigin('https://container.test/path?q=1', policy.remoteOriginAllowlist),
    ).toBe('https://container.test');
    expect(
      resolveApiBaseForThread(policy, {
        runtime: 'remote',
        containerUrl: 'https://container.test/session',
      }),
    ).toBe('https://container.test/api');
    expect(
      resolveApiBaseForThread(policy, {
        runtime: 'remote',
        containerUrl: 'https://blocked.test',
      }),
    ).toBe('/api');
  });
});
