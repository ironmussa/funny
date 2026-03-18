import { ok, err } from 'neverthrow';
import { describe, test, expect, beforeEach, vi } from 'vitest';

const mockApi = vi.hoisted(() => ({
  listArcs: vi.fn(),
  createArc: vi.fn(),
  createArcDirectory: vi.fn(),
  deleteArc: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mockApi }));

import { useArcStore } from '@/stores/arc-store';

beforeEach(() => {
  useArcStore.setState({ arcsByProject: {} });
  vi.clearAllMocks();
});

describe('useArcStore', () => {
  describe('initial state', () => {
    test('arcsByProject starts as empty object', () => {
      expect(useArcStore.getState().arcsByProject).toEqual({});
    });
  });

  describe('loadArcs', () => {
    test('populates arcsByProject on success', async () => {
      const arcs = [
        { id: 'a1', name: 'Arc 1' },
        { id: 'a2', name: 'Arc 2' },
      ];
      mockApi.listArcs.mockResolvedValue(ok(arcs));

      await useArcStore.getState().loadArcs('p1');

      expect(useArcStore.getState().arcsByProject['p1']).toEqual(arcs);
    });

    test('does not crash on API error', async () => {
      mockApi.listArcs.mockResolvedValue(err({ message: 'Network error' }));

      await expect(useArcStore.getState().loadArcs('p1')).resolves.not.toThrow();
      expect(useArcStore.getState().arcsByProject['p1']).toBeUndefined();
    });

    test('updates only the specified project arcs', async () => {
      useArcStore.setState({ arcsByProject: { p1: [{ id: 'existing' }] as any } });
      const newArcs = [{ id: 'a1' }];
      mockApi.listArcs.mockResolvedValue(ok(newArcs));

      await useArcStore.getState().loadArcs('p2');

      expect(useArcStore.getState().arcsByProject['p1']).toEqual([{ id: 'existing' }]);
      expect(useArcStore.getState().arcsByProject['p2']).toEqual(newArcs);
    });
  });

  describe('createArc', () => {
    test('returns created arc on success', async () => {
      const arc = { id: 'a1', name: 'New Arc' };
      mockApi.createArc.mockResolvedValue(ok(arc));
      mockApi.createArcDirectory.mockReturnValue(ok(undefined));
      mockApi.listArcs.mockResolvedValue(ok([arc]));

      const result = await useArcStore.getState().createArc('p1', 'New Arc');

      expect(result).toEqual(arc);
    });

    test('calls createArcDirectory on success', async () => {
      const arc = { id: 'a1', name: 'New Arc' };
      mockApi.createArc.mockResolvedValue(ok(arc));
      mockApi.createArcDirectory.mockReturnValue(ok(undefined));
      mockApi.listArcs.mockResolvedValue(ok([arc]));

      await useArcStore.getState().createArc('p1', 'New Arc');

      expect(mockApi.createArcDirectory).toHaveBeenCalledWith('p1', 'New Arc');
    });

    test('returns null on API error', async () => {
      mockApi.createArc.mockResolvedValue(err({ message: 'Failed' }));

      const result = await useArcStore.getState().createArc('p1', 'New Arc');

      expect(result).toBeNull();
    });
  });

  describe('deleteArc', () => {
    test('reloads arcs for the project after deletion', async () => {
      mockApi.deleteArc.mockResolvedValue(ok(undefined));
      mockApi.listArcs.mockResolvedValue(ok([]));

      await useArcStore.getState().deleteArc('a1', 'p1');

      expect(mockApi.deleteArc).toHaveBeenCalledWith('a1');
      expect(mockApi.listArcs).toHaveBeenCalledWith('p1');
    });

    test('does not crash on API error', async () => {
      mockApi.deleteArc.mockResolvedValue(err({ message: 'Not found' }));

      await expect(useArcStore.getState().deleteArc('a1', 'p1')).resolves.not.toThrow();
    });
  });
});
