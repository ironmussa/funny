/**
 * Authorizer tests (unified-rbac-grants). Pure — fakes, no DB.
 *
 * ACCESS IS EXPLICIT: no cross-resource inheritance. A role on a thread/project
 * comes only from ownership or an explicit grant on THAT resource. Org/project
 * membership grants nothing on a thread. Plus the runner-crossing security gate.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { createAuthorizer, type ProjectMeta, type ThreadMeta } from '../../auth/authorizer.js';
import type { ResourceType, Role } from '../../auth/roles.js';

interface World {
  grants: Map<string, Role>; // `${subject}|${type}|${id}` → explicit grant role
  orgRoles: Map<string, Role>; // `${subject}|${orgId}` → org role (member adapter)
  threads: Map<string, ThreadMeta>;
  projects: Map<string, ProjectMeta>;
}

function build(world: World) {
  return createAuthorizer({
    getGrantRole: async (subject, type: ResourceType, id) =>
      world.grants.get(`${subject}|${type}|${id}`) ?? null,
    getOrgRole: async (subject, orgId) => world.orgRoles.get(`${subject}|${orgId}`) ?? null,
    loadThreadMeta: async (id) => world.threads.get(id) ?? null,
    loadProjectMeta: async (id) => world.projects.get(id) ?? null,
  });
}

describe('authorizer — explicit access, NO inheritance', () => {
  let world: World;
  beforeEach(() => {
    world = { grants: new Map(), orgRoles: new Map(), threads: new Map(), projects: new Map() };
  });

  test('a project grant does NOT grant any role on the project’s threads', async () => {
    world.projects.set('P', { ownerId: 'someone-else' });
    world.threads.set('T', { ownerId: 'someone-else' });
    world.grants.set('U|project|P', 'admin'); // admin on the project…
    const a = build(world);

    // …but nothing on a thread inside it without an explicit thread grant.
    expect(await a.effectiveRole('U', 'thread', 'T')).toBeNull();
    expect(await a.authorize('U', 'thread', 'T', 'view')).toBe(false);
    // The project grant still works ON the project.
    expect(await a.effectiveRole('U', 'project', 'P')).toBe('admin');
  });

  test('an org role does NOT grant any role on the org’s projects', async () => {
    world.orgRoles.set('U|O', 'admin');
    world.projects.set('P', { ownerId: 'someone-else' });
    const a = build(world);

    expect(await a.effectiveRole('U', 'project', 'P')).toBeNull();
    // The org role still works ON the org.
    expect(await a.effectiveRole('U', 'org', 'O')).toBe('admin');
  });

  test('an explicit thread grant is the only non-owner path to a thread', async () => {
    world.threads.set('T', { ownerId: 'someone-else' });
    world.grants.set('U|thread|T', 'viewer');
    const a = build(world);

    expect(await a.effectiveRole('U', 'thread', 'T')).toBe('viewer');
    expect(await a.authorize('U', 'thread', 'T', 'view')).toBe(true);
    expect(await a.authorize('U', 'thread', 'T', 'steer')).toBe(false); // viewer can't steer
  });

  test('creator is owner via the shortcut (no grant row needed)', async () => {
    world.projects.set('P', { ownerId: 'U' });
    world.threads.set('T', { ownerId: 'U' });
    const a = build(world);

    expect(await a.effectiveRole('U', 'project', 'P')).toBe('owner');
    expect(await a.effectiveRole('U', 'thread', 'T')).toBe('owner');
    expect(await a.authorize('U', 'thread', 'T', 'delete')).toBe(true);
  });

  test('a stranger has no role and no capability', async () => {
    world.projects.set('P', { ownerId: 'x' });
    world.threads.set('T', { ownerId: 'x' });
    const a = build(world);

    expect(await a.effectiveRole('STRANGER', 'thread', 'T')).toBeNull();
    expect(await a.authorize('STRANGER', 'thread', 'T', 'view')).toBe(false);
  });

  test('missing resource → null / false', async () => {
    const a = build(world);
    expect(await a.effectiveRole('U', 'thread', 'nope')).toBeNull();
    expect(await a.authorize('U', 'project', 'nope', 'view')).toBe(false);
  });
});

describe('authorizer — runner-crossing security gate', () => {
  let world: World;
  beforeEach(() => {
    world = { grants: new Map(), orgRoles: new Map(), threads: new Map(), projects: new Map() };
  });

  test('a project admin (no thread grant) cannot cross to the owner runner', async () => {
    world.projects.set('P', { ownerId: 'OWNER' });
    world.threads.set('T', { ownerId: 'OWNER' });
    world.grants.set('ADMIN|project|P', 'admin'); // not an explicit thread share
    const a = build(world);

    expect(await a.canCrossToOwnerRunner('ADMIN', 'T')).toBe(false);
    expect(await a.authorize('ADMIN', 'thread', 'T', 'view')).toBe(false); // can't even view
  });

  test('an explicit thread editor grant CAN cross', async () => {
    world.threads.set('T', { ownerId: 'OWNER' });
    world.grants.set('SHAREE|thread|T', 'contributor'); // editor
    const a = build(world);
    expect(await a.canCrossToOwnerRunner('SHAREE', 'T')).toBe(true);
  });

  test('a viewer/commenter thread grant cannot cross', async () => {
    world.threads.set('T', { ownerId: 'OWNER' });
    world.grants.set('V|thread|T', 'viewer');
    world.grants.set('C|thread|T', 'commenter');
    const a = build(world);
    expect(await a.canCrossToOwnerRunner('V', 'T')).toBe(false);
    expect(await a.canCrossToOwnerRunner('C', 'T')).toBe(false);
  });

  test('the owner always crosses to their own runner', async () => {
    world.threads.set('T', { ownerId: 'OWNER' });
    const a = build(world);
    expect(await a.canCrossToOwnerRunner('OWNER', 'T')).toBe(true);
  });
});
