import type { SafeUser } from '@funny/shared';

import { createStore, type StoreApi } from './vanilla-store';

export type AuthSessionPhase = 'bootstrapping' | 'authenticated' | 'anonymous' | 'rejected';

export interface ActiveOrganization {
  id: string;
  name: string | null;
  slug: string | null;
}

export interface AuthSessionState {
  phase: AuthSessionPhase;
  user: SafeUser | null;
  activeOrganization: ActiveOrganization | null;
  rejection: string | null;
  bootstrap(): void;
  authenticate(user: SafeUser, organization?: ActiveOrganization | null): void;
  reject(message: string): void;
  becomeAnonymous(): void;
  logout(): void;
  setActiveOrganization(organization: ActiveOrganization | null): void;
}

export function createAuthSessionStore(): StoreApi<AuthSessionState> {
  return createStore<AuthSessionState>((set, get) => ({
    phase: 'bootstrapping',
    user: null,
    activeOrganization: null,
    rejection: null,
    bootstrap() {
      set({ phase: 'bootstrapping', rejection: null });
    },
    authenticate(user, activeOrganization = null) {
      set({ phase: 'authenticated', user, activeOrganization, rejection: null });
    },
    reject(message) {
      set({ phase: 'rejected', user: null, activeOrganization: null, rejection: message });
    },
    becomeAnonymous() {
      set({ phase: 'anonymous', user: null, activeOrganization: null, rejection: null });
    },
    logout() {
      get().becomeAnonymous();
    },
    setActiveOrganization(activeOrganization) {
      if (get().phase !== 'authenticated') return;
      set({ activeOrganization });
    },
  }));
}
