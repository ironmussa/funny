import { setDataLayerSession } from '@/data/runtime';
import { useAuthStore } from '@/stores/auth-store';

/**
 * Bind the data layer to the authenticated user and active organization:
 * a different user, a logout or an org switch disposes every collection and
 * the request cache before the new session renders. Zustand runs subscribers
 * synchronously inside `set()`, so the swap happens before any component can
 * fetch with the new identity.
 */
export function bindDataLayerToSession(): () => void {
  const sync = () => {
    const { user, activeOrgId } = useAuthStore.getState();
    setDataLayerSession({ userId: user?.id ?? null, orgId: activeOrgId });
  };
  sync();
  return useAuthStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id || state.activeOrgId !== previous.activeOrgId) sync();
  });
}
