import type { AuthMode, SafeUser } from '@funny/shared';
import { create } from 'zustand';

import { setAuthToken, setAuthMode } from '@/lib/api';
import { authClient } from '@/lib/auth-client';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
const BASE = isTauri ? `http://localhost:${serverPort}/api` : '/api';

// Start bootstrap fetch eagerly at module load time (before React mounts)
// so the response is likely already available when initialize() is called.
// We parse JSON here (not in initialize) so the result can be consumed
// multiple times — e.g. when React StrictMode double-fires the effect.
const _bootstrapPromise: Promise<{ mode: AuthMode; token?: string } | null> = fetch(
  `${BASE}/bootstrap`,
)
  .then((res) => (res.ok ? (res.json() as Promise<{ mode: AuthMode; token?: string }>) : null))
  .catch(() => null);

interface AuthState {
  mode: AuthMode | null;
  user: SafeUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  /** Fetch auth mode from server, then check session or token */
  initialize: () => Promise<void>;
  /** Login with username + password (multi mode only) */
  login: (username: string, password: string) => Promise<void>;
  /** Logout (multi mode only) */
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, _get) => ({
  mode: null,
  user: null,
  isAuthenticated: false,
  isLoading: true,

  initialize: async () => {
    set({ isLoading: true });

    try {
      // Use the eagerly-started bootstrap fetch (fired at module load time)
      const data = await _bootstrapPromise;
      if (!data) {
        set({ mode: 'local', isAuthenticated: false, isLoading: false });
        return;
      }
      const { mode } = data;
      set({ mode });
      setAuthMode(mode);

      if (mode === 'local') {
        if (data.token) {
          setAuthToken(data.token);
        }
        set({ isAuthenticated: true, isLoading: false, user: null });
      } else {
        // Multi mode — check Better Auth session
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
      }
    } catch (err) {
      console.error('[auth-store] initialization error:', err);
      set({ mode: 'local', isAuthenticated: false, isLoading: false });
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
    set({ isAuthenticated: false, user: null });
  },
}));
