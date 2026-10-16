import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuthSessionStore } from '@funny/client-core';

import { createNativeClientComposition } from '../platform/composition';
import type { NativeFetch, NativeHeaders } from '../platform/transport';
import { NativeAuthService } from '../services/auth';
import { NativeApiError } from '../services/native-api';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class HeadersStub implements NativeHeaders {
  constructor(private readonly cookies: string[] = []) {}
  get(name: string): string | null {
    return name.toLowerCase() === 'set-cookie' ? (this.cookies[0] ?? null) : null;
  }
  getSetCookie(): string[] {
    return this.cookies;
  }
  forEach(): void {}
}

function response(body: unknown, status = 200, cookies: string[] = []) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new HeadersStub(cookies),
    text: async () => JSON.stringify(body),
  };
}

function setup(
  fetch: NativeFetch,
  delay: (milliseconds: number) => Promise<void> = async () => undefined,
) {
  const directory = mkdtempSync(join(tmpdir(), 'funny-native-auth-'));
  directories.push(directory);
  const composition = createNativeClientComposition({
    dataDirectory: directory,
    persistentSession: false,
    fetch,
    diagnosticSink: () => undefined,
  });
  const state = createAuthSessionStore();
  const auth = new NativeAuthService({
    platform: composition.platform,
    cookies: composition.cookies,
    state,
    clientOrigin: composition.clientOrigin,
    delay,
  });
  return { auth, state, composition };
}

describe('native authentication', () => {
  test('restores session and profile using the native cookie jar', async () => {
    const requests: string[] = [];
    const { auth, state, composition } = setup(async (url) => {
      requests.push(url);
      if (url.endsWith('/api/auth/get-session')) {
        return response(
          {
            user: { id: 'u1', username: 'ada', name: 'Ada', role: 'admin' },
            session: { activeOrganizationId: 'o1' },
          },
          200,
          ['funny.session=restored; Path=/; HttpOnly'],
        );
      }
      return response({ userId: 'u1', setupCompleted: true });
    });
    const result = await auth.restore();
    expect(result).toMatchObject({
      user: { id: 'u1', username: 'ada', role: 'admin' },
    });
    expect(state.getState()).toMatchObject({
      phase: 'authenticated',
      activeOrganization: { id: 'o1' },
    });
    expect(auth.currentProfile()).toMatchObject({ setupCompleted: true });
    expect(composition.cookies.header()).toBe('funny.session=restored');
    expect(requests).toEqual([
      'http://localhost:5002/api/auth/get-session',
      'http://localhost:5002/api/profile',
    ]);
  });

  test('signs in without retaining password and clears rejected or logged-out sessions', async () => {
    const bodies: string[] = [];
    let signedIn = false;
    const { auth, state, composition } = setup(async (url, init) => {
      if (init.body) bodies.push(init.body);
      if (url.endsWith('/sign-in/username')) {
        signedIn = true;
        return response({}, 200, ['funny.session=secret-cookie; Path=/; HttpOnly']);
      }
      if (url.endsWith('/get-session')) {
        return response(signedIn ? { user: { id: 'u1', username: 'ada', name: 'Ada' } } : null);
      }
      return response({});
    });
    await auth.signIn('ada', 'never-store-me');
    expect(state.getState().phase).toBe('authenticated');
    expect(composition.cookies.header()).toBe('funny.session=secret-cookie');
    expect(composition.cookies.header()).not.toContain('never-store-me');
    expect(bodies[0]).toContain('never-store-me');
    auth.rejectSession();
    expect(state.getState().phase).toBe('rejected');
    expect(composition.cookies.header()).toBeNull();
    await auth.logout();
    expect(state.getState().phase).toBe('anonymous');
  });

  test('clears an invalid restored session and supports anonymous operation', async () => {
    const { auth, state, composition } = setup(async () => response(null));
    composition.cookies.capture(new HeadersStub(['funny.session=stale; Path=/; HttpOnly']));
    expect(await auth.restore()).toBeNull();
    expect(state.getState().phase).toBe('anonymous');
    expect(composition.cookies.header()).toBeNull();
  });
  describe('post-sign-in session polling', () => {
    const user = { id: 'u1', username: 'ada', name: 'Ada' };

    function pollingSetup(sessionFor: (poll: number) => ReturnType<typeof response>) {
      const delays: number[] = [];
      let polls = 0;
      const harness = setup(
        async (url) => {
          if (url.endsWith('/sign-in/username')) {
            return response({}, 200, ['funny.session=secret-cookie; Path=/; HttpOnly']);
          }
          if (url.endsWith('/get-session')) return sessionFor(++polls);
          return response({ userId: 'u1' });
        },
        async (milliseconds) => {
          delays.push(milliseconds);
        },
      );
      return { ...harness, delays, polls: () => polls };
    }

    test('keeps polling until the session user appears', async () => {
      const { auth, state, delays, polls } = pollingSetup((poll) =>
        response(poll >= 3 ? { user } : { user: null }),
      );
      const result = await auth.signIn('ada', 'pw');
      expect(result.user).toMatchObject({ id: 'u1', username: 'ada' });
      expect(state.getState().phase).toBe('authenticated');
      expect(polls()).toBe(3);
      expect(delays).toEqual([80, 80]);
    });

    test('gives up after 10 polls and clears the session', async () => {
      const { auth, state, composition, delays, polls } = pollingSetup(() => response(null));
      await expect(auth.signIn('ada', 'pw')).rejects.toThrow(
        'Authenticated session was not established',
      );
      expect(polls()).toBe(10);
      expect(delays).toEqual(Array.from({ length: 9 }, () => 80));
      expect(state.getState().phase).toBe('rejected');
      expect(composition.cookies.header()).toBeNull();
      expect(auth.currentProfile()).toBeNull();
    });

    test('does not retry a hard get-session failure', async () => {
      const { auth, state, composition, delays, polls } = pollingSetup(() =>
        response({ message: 'boom' }, 500),
      );
      const failure = auth.signIn('ada', 'pw');
      await expect(failure).rejects.toBeInstanceOf(NativeApiError);
      await expect(failure).rejects.toMatchObject({ status: 500 });
      expect(polls()).toBe(1);
      expect(delays).toEqual([]);
      expect(state.getState().phase).toBe('rejected');
      expect(composition.cookies.header()).toBeNull();
    });
  });
});
