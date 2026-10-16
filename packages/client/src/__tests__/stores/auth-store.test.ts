import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockAuth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  listOrgs: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  authClient: {
    getSession: mockAuth.getSession,
    signIn: { username: mockAuth.signIn },
    signOut: mockAuth.signOut,
    organization: {
      list: mockAuth.listOrgs,
    },
  },
}));

vi.mock('@/lib/url-state', () => ({
  setActiveOrgSlug: vi.fn(),
}));

vi.mock('@/lib/api/auth-events', () => ({
  onUnauthorized: vi.fn(),
}));

import { setActiveOrgSlug } from '@/lib/url-state';
import { useAuthStore } from '@/stores/auth-store';

describe('auth-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      await vi.advanceTimersByTimeAsync(80 * 2);
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
      const assertion = expect(login).rejects.toThrow('Session was not stored in the browser');
      await vi.advanceTimersByTimeAsync(80 * 10);
      await assertion;

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

  test('setActiveOrg updates slug helper', () => {
    useAuthStore.getState().setActiveOrg('org-2', 'Beta', 'beta');

    expect(useAuthStore.getState().activeOrgSlug).toBe('beta');
    expect(setActiveOrgSlug).toHaveBeenCalledWith('beta');
  });
});
