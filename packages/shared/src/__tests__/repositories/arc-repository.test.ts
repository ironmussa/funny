import { describe, test, expect, beforeEach } from 'bun:test';

import { createArcRepository } from '../../repositories/arc-repository.js';
import { createTestDb, seedProject, seedThread } from '../helpers/test-db.js';

let deps: ReturnType<typeof createTestDb>;
let repo: ReturnType<typeof createArcRepository>;

beforeEach(() => {
  deps = createTestDb();
  repo = createArcRepository(deps);
  seedProject(deps.db);
});

describe('createArc', () => {
  test('returns arc with generated id', async () => {
    const arc = await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Feature X' });
    expect(arc.id).toBeTruthy();
    expect(arc.name).toBe('Feature X');
    expect(arc.projectId).toBe('p1');
    expect(arc.userId).toBe('u1');
    expect(arc.createdAt).toBeTruthy();
  });
});

describe('getArc', () => {
  test('returns arc by ID', async () => {
    const created = await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Arc A' });
    const found = await repo.getArc(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Arc A');
  });

  test('returns undefined for non-existent ID', async () => {
    const found = await repo.getArc('nonexistent');
    expect(found).toBeUndefined();
  });
});

describe('listArcs', () => {
  test('returns arcs for a project+user', async () => {
    await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Arc A' });
    await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Arc B' });
    const arcs = await repo.listArcs('p1', 'u1');
    expect(arcs).toHaveLength(2);
  });

  test('does not return arcs for other users', async () => {
    await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Arc A' });
    await repo.createArc({ projectId: 'p1', userId: 'u2', name: 'Arc B' });
    const arcs = await repo.listArcs('p1', 'u1');
    expect(arcs).toHaveLength(1);
    expect(arcs[0].name).toBe('Arc A');
  });

  test('includes thread count', async () => {
    const arc = await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Arc A' });
    seedThread(deps.db, { id: 't1', arcId: arc.id });
    seedThread(deps.db, { id: 't2', arcId: arc.id });

    const arcs = await repo.listArcs('p1', 'u1');
    expect(arcs[0].threadCount).toBe(2);
  });

  test('returns 0 thread count when no threads linked', async () => {
    await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Empty Arc' });
    const arcs = await repo.listArcs('p1', 'u1');
    expect(arcs[0].threadCount).toBe(0);
  });
});

describe('arcNameExists', () => {
  test('returns true when name exists for project+user', async () => {
    await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Existing' });
    expect(await repo.arcNameExists('p1', 'u1', 'Existing')).toBe(true);
  });

  test('returns false when name does not exist', async () => {
    expect(await repo.arcNameExists('p1', 'u1', 'Nonexistent')).toBe(false);
  });

  test('returns false for same name but different user', async () => {
    await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Shared Name' });
    expect(await repo.arcNameExists('p1', 'u2', 'Shared Name')).toBe(false);
  });
});

describe('deleteArc', () => {
  test('removes the arc record', async () => {
    const arc = await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'To Delete' });
    await repo.deleteArc(arc.id);
    const found = await repo.getArc(arc.id);
    expect(found).toBeUndefined();
  });

  test('unlinks threads referencing the arc', async () => {
    const arc = await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Arc X' });
    seedThread(deps.db, { id: 't1', arcId: arc.id });

    await repo.deleteArc(arc.id);

    const threads = await repo.listArcThreads(arc.id);
    expect(threads).toHaveLength(0);
  });
});

describe('listArcThreads', () => {
  test('returns threads linked to an arc', async () => {
    const arc = await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Arc A' });
    seedThread(deps.db, { id: 't1', arcId: arc.id });
    seedThread(deps.db, { id: 't2', arcId: arc.id });
    seedThread(deps.db, { id: 't3' }); // not linked

    const threads = await repo.listArcThreads(arc.id);
    expect(threads).toHaveLength(2);
  });

  test('returns empty array when no threads linked', async () => {
    const arc = await repo.createArc({ projectId: 'p1', userId: 'u1', name: 'Empty' });
    const threads = await repo.listArcThreads(arc.id);
    expect(threads).toHaveLength(0);
  });
});
