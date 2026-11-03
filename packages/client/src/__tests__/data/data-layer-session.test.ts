import { afterEach, describe, expect, test } from 'vitest';

import { getDataLayer } from '@/data/runtime';
import { bindDataLayerToSession } from '@/lib/data-layer-session';
import { useAuthStore } from '@/stores/auth-store';

import { resetTestDataLayer } from '../helpers/data-layer-harness';

const user = (id: string) =>
  ({ id, username: id, displayName: id, role: 'user' }) as ReturnType<
    typeof useAuthStore.getState
  >['user'];

let unbind: (() => void) | null = null;
afterEach(() => {
  unbind?.();
  unbind = null;
  useAuthStore.setState({ user: null, activeOrgId: null });
  resetTestDataLayer();
});

describe('bindDataLayerToSession', () => {
  test('binds the current session immediately', () => {
    useAuthStore.setState({ user: user('u1'), activeOrgId: 'org-1' });
    unbind = bindDataLayerToSession();
    expect(getDataLayer()).toMatchObject({ userId: 'u1', orgId: 'org-1' });
  });

  test('swaps the layer on user switch, org switch and logout — not on unrelated changes', () => {
    useAuthStore.setState({ user: user('u1'), activeOrgId: null });
    unbind = bindDataLayerToSession();
    const first = getDataLayer();

    useAuthStore.setState({ isLoading: true });
    expect(getDataLayer()).toBe(first);

    useAuthStore.setState({ activeOrgId: 'org-1' });
    const orgLayer = getDataLayer();
    expect(orgLayer).not.toBe(first);
    expect(first.disposed).toBe(true);

    useAuthStore.setState({ user: user('u2') });
    expect(getDataLayer()).toMatchObject({ userId: 'u2', orgId: 'org-1' });
    expect(orgLayer.disposed).toBe(true);

    useAuthStore.setState({ user: null });
    expect(getDataLayer().userId).toBeNull();
  });
});
