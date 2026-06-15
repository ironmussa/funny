/**
 * Unit tests for the canonical RBAC role lattice (unified-rbac-grants, Phase 2).
 * Pure functions — no DB, no Better Auth.
 */
import { describe, expect, test } from 'bun:test';

import {
  CAPABILITY_MIN_RANK,
  ROLES_ASCENDING,
  ROLE_RANK,
  isRole,
  maxRole,
  orgRoleToRole,
  rank,
  roleAtLeast,
  roleCan,
  roleLabel,
  roleToOrgRole,
  roleToThreadLevel,
  threadLevelToRole,
  type Role,
} from '../../auth/roles.js';

describe('role lattice', () => {
  test('rank ordering is total and strictly increasing', () => {
    expect(rank('viewer')).toBeLessThan(rank('commenter'));
    expect(rank('commenter')).toBeLessThan(rank('contributor'));
    expect(rank('contributor')).toBeLessThan(rank('admin'));
    expect(rank('admin')).toBeLessThan(rank('owner'));
    // ROLES_ASCENDING is sorted by rank with no duplicates.
    const ranks = ROLES_ASCENDING.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(Object.values(ROLE_RANK)).size).toBe(5);
  });

  test('roleAtLeast respects the order', () => {
    expect(roleAtLeast('admin', 'contributor')).toBe(true);
    expect(roleAtLeast('contributor', 'contributor')).toBe(true);
    expect(roleAtLeast('viewer', 'contributor')).toBe(false);
    expect(roleAtLeast('owner', 'owner')).toBe(true);
  });

  test('maxRole returns the more privileged role (inheritance max)', () => {
    expect(maxRole('viewer', 'admin')).toBe('admin');
    expect(maxRole('owner', 'contributor')).toBe('owner');
    expect(maxRole('contributor', 'contributor')).toBe('contributor');
  });

  test('isRole narrows untrusted input', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('superuser')).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole('member')).toBe(false); // legacy org label, not canonical
  });
});

describe('capabilities', () => {
  test('each capability requires its minimum rank', () => {
    expect(roleCan('viewer', 'view')).toBe(true);
    expect(roleCan('viewer', 'comment')).toBe(false);
    expect(roleCan('commenter', 'comment')).toBe(true);
    expect(roleCan('commenter', 'steer')).toBe(false);
    expect(roleCan('contributor', 'steer')).toBe(true);
    expect(roleCan('contributor', 'manage')).toBe(false);
    expect(roleCan('admin', 'manage')).toBe(true);
    expect(roleCan('admin', 'delete')).toBe(false);
    expect(roleCan('owner', 'delete')).toBe(true);
  });

  test('capability ranks line up with role ranks', () => {
    expect(CAPABILITY_MIN_RANK.view).toBe(ROLE_RANK.viewer);
    expect(CAPABILITY_MIN_RANK.comment).toBe(ROLE_RANK.commenter);
    expect(CAPABILITY_MIN_RANK.steer).toBe(ROLE_RANK.contributor);
    expect(CAPABILITY_MIN_RANK.manage).toBe(ROLE_RANK.admin);
    expect(CAPABILITY_MIN_RANK.delete).toBe(ROLE_RANK.owner);
  });
});

describe('thread share level aliases (viewer / commenter / editor)', () => {
  test('the three levels map onto the lattice', () => {
    expect(threadLevelToRole('view')).toBe('viewer');
    expect(threadLevelToRole('comment')).toBe('commenter');
    expect(threadLevelToRole('steer')).toBe('contributor');
  });

  test('roleToThreadLevel collapses each role to its level', () => {
    expect(roleToThreadLevel('viewer')).toBe('view');
    expect(roleToThreadLevel('commenter')).toBe('comment');
    expect(roleToThreadLevel('contributor')).toBe('steer');
    expect(roleToThreadLevel('admin')).toBe('steer');
    expect(roleToThreadLevel('owner')).toBe('steer');
  });

  test('every level round-trips through the canonical role', () => {
    for (const level of ['view', 'comment', 'steer'] as const) {
      expect(roleToThreadLevel(threadLevelToRole(level))).toBe(level);
    }
  });
});

describe('legacy org role aliases', () => {
  test("'member' is the canonical 'contributor'", () => {
    expect(orgRoleToRole('member')).toBe('contributor');
    expect(roleToOrgRole('contributor')).toBe('member');
  });

  test('owner/admin/viewer pass through unchanged', () => {
    for (const r of ['owner', 'admin', 'viewer'] as const) {
      expect(orgRoleToRole(r)).toBe(r);
      expect(roleToOrgRole(r as Role)).toBe(r);
    }
  });
});

describe('roleLabel', () => {
  test('thread scope: Viewer / Commenter / Editor', () => {
    expect(roleLabel('thread', 'viewer')).toBe('Viewer');
    expect(roleLabel('thread', 'commenter')).toBe('Commenter');
    expect(roleLabel('thread', 'contributor')).toBe('Editor');
    expect(roleLabel('thread', 'owner')).toBe('Owner');
  });

  test('org/project scope use Member for contributor', () => {
    expect(roleLabel('org', 'contributor')).toBe('Member');
    expect(roleLabel('project', 'contributor')).toBe('Member');
    expect(roleLabel('project', 'admin')).toBe('Admin');
    expect(roleLabel('org', 'viewer')).toBe('Viewer');
  });
});
