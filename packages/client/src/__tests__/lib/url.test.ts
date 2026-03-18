import { describe, test, expect, beforeEach } from 'vitest';

import { buildPath, stripOrgPrefix } from '@/lib/url';
import { useAuthStore } from '@/stores/auth-store';

// Reset auth store before each test
beforeEach(() => {
  useAuthStore.setState({ activeOrgSlug: null });
});

// ── stripOrgPrefix ───────────────────────────────────────────────

describe('stripOrgPrefix', () => {
  test('returns [null, "/"] for root path "/"', () => {
    expect(stripOrgPrefix('/')).toEqual([null, '/']);
  });

  test('returns [null, pathname] for static route /projects', () => {
    expect(stripOrgPrefix('/projects')).toEqual([null, '/projects']);
  });

  test('returns [null, pathname] for static route /settings', () => {
    expect(stripOrgPrefix('/settings')).toEqual([null, '/settings']);
  });

  test('returns [null, pathname] for all known static routes', () => {
    const statics = [
      'projects',
      'settings',
      'preferences',
      'inbox',
      'list',
      'kanban',
      'analytics',
      'grid',
      'new',
      'invite',
    ];
    for (const route of statics) {
      const [slug, path] = stripOrgPrefix(`/${route}`);
      expect(slug).toBeNull();
      expect(path).toBe(`/${route}`);
    }
  });

  test('returns [slug, rest] for org-prefixed path', () => {
    expect(stripOrgPrefix('/my-org/projects')).toEqual(['my-org', '/projects']);
  });

  test('returns [slug, "/"] when org slug is the only segment', () => {
    expect(stripOrgPrefix('/my-org')).toEqual(['my-org', '/']);
  });

  test('handles deep nested paths', () => {
    expect(stripOrgPrefix('/my-org/projects/123/threads')).toEqual([
      'my-org',
      '/projects/123/threads',
    ]);
  });

  test('handles empty string input', () => {
    expect(stripOrgPrefix('')).toEqual([null, '/']);
  });
});

// ── buildPath ────────────────────────────────────────────────────

describe('buildPath', () => {
  test('returns path as-is when no activeOrgSlug', () => {
    expect(buildPath('/projects')).toBe('/projects');
  });

  test('prefixes org slug to path', () => {
    useAuthStore.setState({ activeOrgSlug: 'acme' });
    expect(buildPath('/projects')).toBe('/acme/projects');
  });

  test('avoids double-prefixing', () => {
    useAuthStore.setState({ activeOrgSlug: 'acme' });
    expect(buildPath('/acme/projects')).toBe('/acme/projects');
  });

  test('avoids double-prefixing exact slug match', () => {
    useAuthStore.setState({ activeOrgSlug: 'acme' });
    expect(buildPath('/acme')).toBe('/acme');
  });

  test('handles path without leading slash', () => {
    useAuthStore.setState({ activeOrgSlug: 'acme' });
    expect(buildPath('projects')).toBe('/acme/projects');
  });
});
