import type { Automation, InboxItem, AutomationRun } from '@funny/shared';
import { ok, err } from 'neverthrow';
import { describe, test, expect, beforeEach, vi } from 'vitest';

const mockApi = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  getAutomationInbox: vi.fn(),
  listAutomationRuns: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  triggerAutomation: vi.fn(),
  triageRun: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mockApi }));

import { useAutomationStore } from '@/stores/automation-store';

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    projectId: 'p1',
    name: 'Test Automation',
    trigger: 'manual',
    prompt: 'Do something',
    enabled: true,
    createdAt: '2024-01-01',
    ...overrides,
  } as Automation;
}

function makeInboxItem(overrides: Partial<{ run: Partial<AutomationRun> }> = {}): InboxItem {
  return {
    automation: makeAutomation(),
    run: {
      id: 'run-1',
      automationId: 'auto-1',
      threadId: 't1',
      status: 'completed',
      triageStatus: 'pending',
      createdAt: '2024-01-01',
      ...overrides.run,
    },
  } as InboxItem;
}

beforeEach(() => {
  useAutomationStore.setState({
    automationsByProject: {},
    inbox: [],
    inboxCount: 0,
    selectedAutomationRuns: [],
  });
  vi.clearAllMocks();
});

describe('useAutomationStore', () => {
  describe('initial state', () => {
    test('starts with empty state', () => {
      const state = useAutomationStore.getState();
      expect(state.automationsByProject).toEqual({});
      expect(state.inbox).toEqual([]);
      expect(state.inboxCount).toBe(0);
      expect(state.selectedAutomationRuns).toEqual([]);
    });
  });

  describe('loadAutomations', () => {
    test('populates automationsByProject on success', async () => {
      const automations = [makeAutomation({ id: 'a1' }), makeAutomation({ id: 'a2' })];
      mockApi.listAutomations.mockResolvedValue(ok(automations));

      await useAutomationStore.getState().loadAutomations('p1');

      expect(useAutomationStore.getState().automationsByProject['p1']).toEqual(automations);
    });

    test('handles API error gracefully', async () => {
      mockApi.listAutomations.mockResolvedValue(err({ message: 'fail' }));

      await expect(useAutomationStore.getState().loadAutomations('p1')).resolves.not.toThrow();
    });
  });

  describe('loadInbox', () => {
    test('sets inbox and counts pending items', async () => {
      const items = [
        makeInboxItem({ run: { id: 'r1', triageStatus: 'pending' } }),
        makeInboxItem({ run: { id: 'r2', triageStatus: 'reviewed' } }),
        makeInboxItem({ run: { id: 'r3', triageStatus: 'pending' } }),
      ];
      mockApi.getAutomationInbox.mockResolvedValue(ok(items));

      await useAutomationStore.getState().loadInbox();

      expect(useAutomationStore.getState().inbox).toEqual(items);
      expect(useAutomationStore.getState().inboxCount).toBe(2);
    });

    test('counts only pending triage status items', async () => {
      const items = [
        makeInboxItem({ run: { id: 'r1', triageStatus: 'dismissed' } }),
        makeInboxItem({ run: { id: 'r2', triageStatus: 'reviewed' } }),
      ];
      mockApi.getAutomationInbox.mockResolvedValue(ok(items));

      await useAutomationStore.getState().loadInbox();

      expect(useAutomationStore.getState().inboxCount).toBe(0);
    });
  });

  describe('createAutomation', () => {
    test('returns created automation on success', async () => {
      const automation = makeAutomation();
      mockApi.createAutomation.mockResolvedValue(ok(automation));

      const result = await useAutomationStore.getState().createAutomation({
        projectId: 'p1',
        name: 'Test',
        trigger: 'manual',
        prompt: 'test',
      } as any);

      expect(result).toEqual(automation);
    });

    test('adds automation to beginning of project list', async () => {
      const existing = makeAutomation({ id: 'old' });
      useAutomationStore.setState({ automationsByProject: { p1: [existing] } });

      const newAuto = makeAutomation({ id: 'new', projectId: 'p1' });
      mockApi.createAutomation.mockResolvedValue(ok(newAuto));

      await useAutomationStore.getState().createAutomation({ projectId: 'p1' } as any);

      const list = useAutomationStore.getState().automationsByProject['p1'];
      expect(list[0].id).toBe('new');
      expect(list[1].id).toBe('old');
    });

    test('creates empty project list if none exists', async () => {
      const automation = makeAutomation({ projectId: 'new-project' });
      mockApi.createAutomation.mockResolvedValue(ok(automation));

      await useAutomationStore.getState().createAutomation({ projectId: 'new-project' } as any);

      expect(useAutomationStore.getState().automationsByProject['new-project']).toHaveLength(1);
    });

    test('returns null on API error', async () => {
      mockApi.createAutomation.mockResolvedValue(err({ message: 'fail' }));

      const result = await useAutomationStore
        .getState()
        .createAutomation({ projectId: 'p1' } as any);

      expect(result).toBeNull();
    });
  });

  describe('updateAutomation', () => {
    test('replaces automation in all project lists by id', async () => {
      const original = makeAutomation({ id: 'a1', name: 'Original' });
      useAutomationStore.setState({ automationsByProject: { p1: [original] } });

      const updated = makeAutomation({ id: 'a1', name: 'Updated' });
      mockApi.updateAutomation.mockResolvedValue(ok(updated));

      await useAutomationStore.getState().updateAutomation('a1', { name: 'Updated' } as any);

      expect(useAutomationStore.getState().automationsByProject['p1'][0].name).toBe('Updated');
    });

    test('handles API error gracefully', async () => {
      mockApi.updateAutomation.mockResolvedValue(err({ message: 'fail' }));

      await expect(
        useAutomationStore.getState().updateAutomation('a1', {} as any),
      ).resolves.not.toThrow();
    });
  });

  describe('deleteAutomation', () => {
    test('removes automation from project list', async () => {
      const a1 = makeAutomation({ id: 'a1' });
      const a2 = makeAutomation({ id: 'a2' });
      useAutomationStore.setState({ automationsByProject: { p1: [a1, a2] } });

      mockApi.deleteAutomation.mockResolvedValue(ok(undefined));

      await useAutomationStore.getState().deleteAutomation('a1', 'p1');

      const list = useAutomationStore.getState().automationsByProject['p1'];
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('a2');
    });

    test('handles non-existent project list gracefully', async () => {
      mockApi.deleteAutomation.mockResolvedValue(ok(undefined));

      await expect(
        useAutomationStore.getState().deleteAutomation('a1', 'nonexistent'),
      ).resolves.not.toThrow();
    });
  });

  describe('triageRun', () => {
    test('updates triage status in inbox items', async () => {
      const items = [makeInboxItem({ run: { id: 'r1', triageStatus: 'pending' } })];
      useAutomationStore.setState({ inbox: items, inboxCount: 1 });

      mockApi.triageRun.mockResolvedValue(ok(undefined));

      await useAutomationStore.getState().triageRun('r1', 'reviewed');

      expect(useAutomationStore.getState().inbox[0].run.triageStatus).toBe('reviewed');
    });

    test('recalculates pending count after triage', async () => {
      const items = [
        makeInboxItem({ run: { id: 'r1', triageStatus: 'pending' } }),
        makeInboxItem({ run: { id: 'r2', triageStatus: 'pending' } }),
      ];
      useAutomationStore.setState({ inbox: items, inboxCount: 2 });

      mockApi.triageRun.mockResolvedValue(ok(undefined));

      await useAutomationStore.getState().triageRun('r1', 'dismissed');

      expect(useAutomationStore.getState().inboxCount).toBe(1);
    });

    test('handles API error gracefully', async () => {
      mockApi.triageRun.mockResolvedValue(err({ message: 'fail' }));

      await expect(
        useAutomationStore.getState().triageRun('r1', 'reviewed'),
      ).resolves.not.toThrow();
    });
  });

  describe('handleRunStarted', () => {
    test('calls loadInbox', async () => {
      mockApi.getAutomationInbox.mockResolvedValue(ok([]));

      useAutomationStore
        .getState()
        .handleRunStarted({ automationId: 'a1', runId: 'r1', threadId: 't1' });

      // Give the async loadInbox call time to execute
      await vi.waitFor(() => expect(mockApi.getAutomationInbox).toHaveBeenCalled());
    });
  });

  describe('handleRunCompleted', () => {
    test('calls loadInbox', async () => {
      mockApi.getAutomationInbox.mockResolvedValue(ok([]));

      useAutomationStore.getState().handleRunCompleted({
        automationId: 'a1',
        runId: 'r1',
        hasFindings: false,
      });

      await vi.waitFor(() => expect(mockApi.getAutomationInbox).toHaveBeenCalled());
    });

    test('refreshes runs if viewing same automation', async () => {
      const runs = [{ automationId: 'a1', id: 'r1' }] as AutomationRun[];
      useAutomationStore.setState({ selectedAutomationRuns: runs });

      mockApi.getAutomationInbox.mockResolvedValue(ok([]));
      mockApi.listAutomationRuns.mockResolvedValue(ok([]));

      useAutomationStore.getState().handleRunCompleted({
        automationId: 'a1',
        runId: 'r2',
        hasFindings: true,
      });

      await vi.waitFor(() => expect(mockApi.listAutomationRuns).toHaveBeenCalledWith('a1'));
    });
  });
});
