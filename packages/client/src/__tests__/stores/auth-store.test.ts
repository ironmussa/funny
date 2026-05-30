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
