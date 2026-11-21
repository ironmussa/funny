import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { advanceTimersByTimeAsync } from '@funny/test-kit';

const mockAuth = (() => ({
  getSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  listOrgs: vi.fn(),
}))();

mock.module('@/lib/auth-client', () => ({
  authClient: {
    getSession: mockAuth.getSession,
    signIn: { username: mockAuth.signIn },
    signOut: mockAuth.signOut,
    organization: {
      list: mockAuth.listOrgs,
    },
  },
}));

mock.module('@/lib/url-state', () => ({
  setActiveOrgSlug: vi.fn(),
}));

mock.module('@/lib/api/auth-events', () => ({
  onUnauthorized: vi.fn(),
}));

const mockReload = (() => vi.fn())();
const actualLibLogoutCleanup = { ...(await import('@/lib/logout-cleanup')) };
mock.module('@/lib/logout-cleanup', () => ({
  ...actualLibLogoutCleanup,
  reloadAfterLogout: mockReload,
}));

const mockDropPush = (() => vi.fn())();
mock.module('@/lib/web-push', () => ({ dropWebPushSubscription: mockDropPush }));

const { setActiveOrgSlug } = await import('@/lib/url-state');
const { useAuthStore } = await import('@/stores/auth-store');

describe('auth-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDropPush.mockResolvedValue(undefined);
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      activeOrgId: null,
      activeOrgName: null,
      activeOrgSlug: null,
    });
  });

  afterEach(() => {
    localStorage.clear();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      activeOrgId: null,
      activeOrgName: null,
      activeOrgSlug: null,
    });
  });

  test('initialize sets user and org context from session', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: {
        user: {
          id: 'u1',
          username: 'admin',
          name: 'Admin',
          role: 'admin',
        },
        session: { activeOrganizationId: 'org-1' },
      },
    });
    mockAuth.listOrgs.mockResolvedValue({
      data: [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
    });

    await useAuthStore.getState().initialize();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);
    expect(state.user?.id).toBe('u1');
    expect(state.activeOrgId).toBe('org-1');
    expect(state.activeOrgName).toBe('Acme');
    expect(setActiveOrgSlug).toHaveBeenCalledWith('acme');
  });

  test('initialize clears auth when session is empty', async () => {
    mockAuth.getSession.mockResolvedValue({ data: null });

    await useAuthStore.getState().initialize();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(setActiveOrgSlug).toHaveBeenCalledWith(null);
  });

  test('login throws when sign-in returns an error', async () => {
    mockAuth.signIn.mockResolvedValue({ error: { message: 'Invalid credentials' } });

    await expect(useAuthStore.getState().login('bad', 'creds')).rejects.toThrow(
      'Invalid credentials',
    );
  });

  test('login sets authenticated user after session is visible', async () => {
    mockAuth.signIn.mockResolvedValue({ error: null });
    mockAuth.getSession.mockResolvedValue({
      data: { user: { id: 'u2', username: 'dev', name: 'Dev' } },
    });

    await useAuthStore.getState().login('dev', 'secret');

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.username).toBe('dev');
  });

  test('login polls until the session cookie is visible', async () => {
    vi.useFakeTimers();
    try {
      mockAuth.signIn.mockResolvedValue({ error: null });
      mockAuth.getSession
        .mockResolvedValueOnce({ data: null })
        .mockResolvedValueOnce({ data: null })
        .mockResolvedValue({ data: { user: { id: 'u3', username: 'late', name: 'Late' } } });

      const login = useAuthStore.getState().login('late', 'secret');
      await advanceTimersByTimeAsync(80 * 2);
      await login;

      expect(mockAuth.getSession).toHaveBeenCalledTimes(3);
      expect(useAuthStore.getState().user?.username).toBe('late');
    } finally {
      vi.useRealTimers();
    }
  });

  test('login gives up after 10 retries when the session never appears', async () => {
    vi.useFakeTimers();
    try {
      mockAuth.signIn.mockResolvedValue({ error: null });
      mockAuth.getSession.mockResolvedValue({ data: null });

      const login = useAuthStore.getState().login('ghost', 'secret');
      // bun's `rejects` waits for the promise where it is written, so assert
      // after the timers have run; until then, mark the rejection as handled.
      login.catch(() => {});
      await advanceTimersByTimeAsync(80 * 10);
      await expect(login).rejects.toThrow('Session was not stored in the browser');

      expect(mockAuth.getSession).toHaveBeenCalledTimes(11);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('login does not retry a failing getSession call', async () => {
    mockAuth.signIn.mockResolvedValue({ error: null });
    mockAuth.getSession.mockRejectedValue(new Error('network down'));

    await expect(useAuthStore.getState().login('dev', 'secret')).rejects.toThrow('network down');
    expect(mockAuth.getSession).toHaveBeenCalledTimes(1);
  });

  test('a session check that resolves after a login does not undo it', async () => {
    let finishPageLoadCheck!: (value: unknown) => void;
    mockAuth.getSession.mockImplementationOnce(
      () => new Promise((resolve) => (finishPageLoadCheck = resolve)),
    );
    const pageLoad = useAuthStore.getState().initialize(); // no session yet

    mockAuth.signIn.mockResolvedValue({ error: null });
    mockAuth.getSession.mockResolvedValue({ data: { user: { id: 'u1', username: 'alice' } } });
    await useAuthStore.getState().login('alice', 'pw');

    finishPageLoadCheck({ data: null });
    await pageLoad;

    expect(useAuthStore.getState()).toMatchObject({
      isAuthenticated: true,
      isLoading: false,
      user: expect.objectContaining({ id: 'u1' }),
    });
  });

  test('logout clears user and org state', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'u1', username: 'x', displayName: 'X', role: 'user' },
      activeOrgId: 'org-1',
      activeOrgName: 'Acme',
      activeOrgSlug: 'acme',
      isLoading: false,
    });
    mockAuth.signOut.mockResolvedValue(undefined);

    await useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(state.activeOrgId).toBeNull();
    expect(setActiveOrgSlug).toHaveBeenCalledWith(null);
  });

  test("logout leaves none of the previous user's data behind", async () => {
    localStorage.clear();
    localStorage.setItem('funny-terminal-store', '{"state":{"tabs":[{"threadId":"t1"}]}}');
    localStorage.setItem('funny_last_route', '/projects/p1/threads/t1');
    localStorage.setItem('theme', 'dark');
    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'u1', username: 'x', displayName: 'X', role: 'user' },
      isLoading: false,
    });
    mockAuth.signOut.mockResolvedValue(undefined);

    await useAuthStore.getState().logout();

    expect(localStorage.getItem('funny-terminal-store')).toBeNull();
    expect(localStorage.getItem('funny_last_route')).toBeNull();
    expect(localStorage.getItem('theme')).toBe('dark');
    // The reload drops every in-memory store (threads, drafts, terminals).
    expect(mockReload).toHaveBeenCalledTimes(1);
    // ...and this browser stops receiving their push notifications, before
    // the session (which the server unsubscribe needs) is gone.
    expect(mockDropPush).toHaveBeenCalledTimes(1);
    expect(mockDropPush.mock.invocationCallOrder[0]).toBeLessThan(
      mockAuth.signOut.mock.invocationCallOrder[0],
    );
  });

  test('logout still clears and reloads when the push unsubscribe fails', async () => {
    localStorage.setItem('funny_last_route', '/projects/p1/threads/t1');
    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'u1', username: 'x', displayName: 'X', role: 'user' },
      isLoading: false,
    });
    mockDropPush.mockRejectedValue(new Error('offline'));
    mockAuth.signOut.mockResolvedValue(undefined);

    await useAuthStore.getState().logout();

    expect(localStorage.getItem('funny_last_route')).toBeNull();
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  test('logout without a signed-in user does not reload (no 401 reload loop)', async () => {
    localStorage.setItem('funny_last_route', '/');
    useAuthStore.setState({ isAuthenticated: false, user: null, isLoading: false });
    mockAuth.signOut.mockResolvedValue(undefined);

    await useAuthStore.getState().logout();

    expect(mockReload).not.toHaveBeenCalled();
    expect(mockDropPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('funny_last_route')).toBe('/');
  });

  test('setActiveOrg updates slug helper', () => {
    useAuthStore.getState().setActiveOrg('org-2', 'Beta', 'beta');

    expect(useAuthStore.getState().activeOrgSlug).toBe('beta');
    expect(setActiveOrgSlug).toHaveBeenCalledWith('beta');
  });
});
