import type { SafeUser } from '@funny/shared';
import { create } from 'zustand';

import { authClient } from '@/lib/auth-client';

interface AuthState {
  user: SafeUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Active organization info (set by OrgSwitcher) */
  activeOrgId: string | null;
  activeOrgName: string | null;
  activeOrgSlug: string | null;

  /** Check Better Auth session */
  initialize: () => Promise<void>;
  /** Login with username + password */
  login: (username: string, password: string) => Promise<void>;
  /** Logout */
  logout: () => Promise<void>;
  /** Set active organization */
  setActiveOrg: (id: string | null, name: string | null, slug?: string | null) => void;
}

export const useAuthStore = create<AuthState>((set, _get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  activeOrgId: null,
  activeOrgName: null,
  activeOrgSlug: null,

  initialize: async () => {
    set({ isLoading: true });

    try {
      const session = await authClient.getSession();
      if (session.data?.user) {
        const u = session.data.user as any;
        set({
          isAuthenticated: true,
          isLoading: false,
          user: {
            id: u.id,
            username: u.username || u.name || 'user',
            displayName: u.name || u.username || 'User',
            role: u.role || 'user',
          },
        });
      } else {
        set({ isAuthenticated: false, isLoading: false, user: null });
      }
    } catch (err) {
      console.error('[auth-store] initialization error:', err);
      set({ isAuthenticated: false, isLoading: false });
    }
  },

  login: async (username: string, password: string) => {
    const result = await authClient.signIn.username({
      username,
      password,
    });

    if (result.error) {
      throw new Error(result.error.message || 'Login failed');
    }

    const u = result.data?.user as any;
    if (u) {
      set({
        isAuthenticated: true,
        user: {
          id: u.id,
          username: u.username || u.name || 'user',
          displayName: u.name || u.username || 'User',
          role: u.role || 'user',
        },
      });
    }
  },

  logout: async () => {
    try {
      await authClient.signOut();
    } catch {
      // Ignore errors
    }
    set({
      isAuthenticated: false,
      user: null,
      activeOrgId: null,
      activeOrgName: null,
      activeOrgSlug: null,
    });
  },

  setActiveOrg: (id, name, slug) =>
    set({ activeOrgId: id, activeOrgName: name, activeOrgSlug: slug ?? null }),
}));
