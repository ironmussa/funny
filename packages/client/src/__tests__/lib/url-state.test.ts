import { beforeEach, describe, expect, test } from 'vitest';

import { getActiveOrgSlug, setActiveOrgSlug } from '@/lib/url-state';

describe('url-state', () => {
  beforeEach(() => {
    setActiveOrgSlug(null);
  });

  test('starts with no active org slug', () => {
    expect(getActiveOrgSlug()).toBeNull();
  });

  test('stores and returns the active org slug', () => {
    setActiveOrgSlug('acme');
    expect(getActiveOrgSlug()).toBe('acme');
  });

  test('can clear the active org slug', () => {
    setActiveOrgSlug('acme');
    setActiveOrgSlug(null);
    expect(getActiveOrgSlug()).toBeNull();
  });
});
