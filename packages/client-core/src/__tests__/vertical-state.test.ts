import { describe, expect, test } from 'bun:test';

import type { Message, Project, SafeUser, Thread } from '@funny/shared';

import { createAuthSessionStore } from '../stores/auth-session';
import { createThreadNavigationStore, uniqueEntityIds } from '../stores/thread-navigation';

const user: SafeUser = { id: 'u1', username: 'ada', displayName: 'Ada', role: 'user' };
const project = (id: string): Project => ({ id, name: id }) as Project;
const thread = (id: string, projectId = 'p1'): Thread => ({ id, projectId, title: id }) as Thread;
const message = (id: string, content = id): Message => ({
  id,
  threadId: 't1',
  role: 'assistant',
  content,
  timestamp: `2026-08-23T00:00:0${id}.000Z`,
});

describe('portable auth state', () => {
  test('models bootstrap, authenticated, rejected, anonymous, and logout transitions', () => {
    const store = createAuthSessionStore();
    expect(store.getState().phase).toBe('bootstrapping');
    store.getState().authenticate(user, { id: 'o1', name: 'Team', slug: 'team' });
    expect(store.getState()).toMatchObject({ phase: 'authenticated', user });
    store.getState().setActiveOrganization(null);
    expect(store.getState().activeOrganization).toBeNull();
    store.getState().reject('expired');
    expect(store.getState()).toMatchObject({ phase: 'rejected', user: null, rejection: 'expired' });
    store.getState().bootstrap();
    store.getState().becomeAnonymous();
    expect(store.getState().phase).toBe('anonymous');
    store.getState().authenticate(user);
    store.getState().logout();
    expect(store.getState()).toMatchObject({ phase: 'anonymous', user: null });
  });
});

describe('portable navigation state', () => {
  test('keeps server order and groups project, scratch, and shared threads without duplicates', () => {
    const store = createThreadNavigationStore();
    store.getState().replaceProjects([project('p2'), project('p1')]);
    store.getState().selectProject('p1');
    store.getState().replaceProjectThreads('p1', [thread('t2'), thread('t1'), thread('t2')], 5);
    store.getState().appendProjectThreads('p1', [thread('t1'), thread('t3')], 5);
    store.getState().replaceScratchThreads([thread('s1', ''), thread('s1', '')]);
    store.getState().replaceSharedThreads([thread('h1', 'other')], 2);
    expect(store.getState()).toMatchObject({
      projectIds: ['p2', 'p1'],
      selectedProjectId: 'p1',
      threadIdsByProject: { p1: ['t2', 't1', 't3'] },
      threadTotalByProject: { p1: 5 },
      scratchThreadIds: ['s1'],
      scratchThreadTotal: 1,
      sharedThreadIds: ['h1'],
      sharedThreadTotal: 2,
    });
  });

  test('clears protected resources and selection on logout', () => {
    const store = createThreadNavigationStore();
    store.getState().replaceProjects([project('p1')]);
    store.getState().replaceProjectThreads('p1', [thread('t1')]);
    store.getState().selectProject('p1');
    store.getState().removeProtectedResources();
    expect(store.getState()).toMatchObject({
      projectIds: [],
      threadsById: {},
      selectedProjectId: null,
    });
  });

  test('drops inaccessible project buckets when the accessible project set changes', () => {
    const store = createThreadNavigationStore();
    store.getState().replaceProjects([project('p1'), project('p2')]);
    store.getState().replaceProjectThreads('p1', [thread('t1', 'p1')]);
    store.getState().replaceProjectThreads('p2', [thread('t2', 'p2')]);
    store.getState().replaceProjects([project('p2')]);
    expect(store.getState().threadIdsByProject).toEqual({ p2: ['t2'] });
    expect(store.getState().threadsById.t1).toBeUndefined();
    expect(store.getState().threadsById.t2).toBeDefined();
  });

  test('exports the same ordered de-duplication used by the web adapter', () => {
    expect(uniqueEntityIds([message('1'), message('2'), message('1')])).toEqual(['1', '2']);
  });
});
