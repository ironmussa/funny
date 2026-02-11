import { describe, test, expect, vi, beforeEach } from 'vitest';
import { useAppStore } from '@/stores/app-store';
import { okAsync, errAsync } from 'neverthrow';
import type { DomainError } from '@a-parallel/shared/errors';

// Mock the api module
vi.mock('@/lib/api', () => ({
  api: {
    listProjects: vi.fn(),
    listThreads: vi.fn(),
    getThread: vi.fn(),
    archiveThread: vi.fn(),
  },
}));

import { api } from '@/lib/api';
const mockApi = vi.mocked(api);

describe('AppStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useAppStore.setState({
      projects: [],
      threadsByProject: {},
      activeThread: null,
      selectedProjectId: null,
      selectedThreadId: null,
      expandedProjects: new Set(),
      reviewPaneOpen: false,
      newThreadProjectId: null,
    });
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    test('has empty projects', () => {
      expect(useAppStore.getState().projects).toEqual([]);
    });

    test('has no active thread', () => {
      expect(useAppStore.getState().activeThread).toBeNull();
    });

    test('has no selected project', () => {
      expect(useAppStore.getState().selectedProjectId).toBeNull();
    });

    test('review pane is closed', () => {
      expect(useAppStore.getState().reviewPaneOpen).toBe(false);
    });
  });

  describe('loadProjects', () => {
    test('fetches and stores projects', async () => {
      const mockProjects = [
        { id: 'p1', name: 'Project 1', path: '/tmp/p1', createdAt: '2024-01-01' },
      ];
      mockApi.listProjects.mockReturnValueOnce(okAsync(mockProjects) as any);
      mockApi.listThreads.mockReturnValue(okAsync([]) as any);

      await useAppStore.getState().loadProjects();
      expect(useAppStore.getState().projects).toEqual(mockProjects);
    });
  });

  describe('loadThreadsForProject', () => {
    test('fetches and stores threads', async () => {
      const mockThreads = [
        { id: 't1', projectId: 'p1', title: 'Thread 1', status: 'completed' },
      ];
      mockApi.listThreads.mockReturnValueOnce(okAsync(mockThreads) as any);

      await useAppStore.getState().loadThreadsForProject('p1');
      expect(useAppStore.getState().threadsByProject['p1']).toEqual(mockThreads);
    });
  });

  describe('toggleProject', () => {
    test('expands a collapsed project', () => {
      mockApi.listThreads.mockReturnValueOnce(okAsync([]) as any);

      useAppStore.getState().toggleProject('p1');
      expect(useAppStore.getState().expandedProjects.has('p1')).toBe(true);
    });

    test('collapses an expanded project', () => {
      useAppStore.setState({ expandedProjects: new Set(['p1']) });

      useAppStore.getState().toggleProject('p1');
      expect(useAppStore.getState().expandedProjects.has('p1')).toBe(false);
    });
  });

  describe('selectProject', () => {
    test('sets selectedProjectId', () => {
      mockApi.listThreads.mockReturnValueOnce(okAsync([]) as any);

      useAppStore.getState().selectProject('p1');
      expect(useAppStore.getState().selectedProjectId).toBe('p1');
    });

    test('expands the project', () => {
      mockApi.listThreads.mockReturnValueOnce(okAsync([]) as any);

      useAppStore.getState().selectProject('p1');
      expect(useAppStore.getState().expandedProjects.has('p1')).toBe(true);
    });

    test('clears selection with null', () => {
      useAppStore.setState({ selectedProjectId: 'p1' });

      useAppStore.getState().selectProject(null);
      expect(useAppStore.getState().selectedProjectId).toBeNull();
    });
  });

  describe('selectThread', () => {
    test('fetches thread and sets activeThread', async () => {
      const mockThread = {
        id: 't1',
        projectId: 'p1',
        title: 'Test',
        messages: [],
        status: 'completed',
      };
      mockApi.getThread.mockReturnValueOnce(okAsync(mockThread) as any);
      mockApi.listThreads.mockReturnValueOnce(okAsync([]) as any);

      await useAppStore.getState().selectThread('t1');
      // selectThread enriches the thread with initInfo, resultInfo, waitingReason
      expect(useAppStore.getState().activeThread).toMatchObject(mockThread);
      expect(useAppStore.getState().selectedThreadId).toBe('t1');
    });

    test('clears activeThread with null', async () => {
      useAppStore.setState({ activeThread: { id: 't1' } as any });

      await useAppStore.getState().selectThread(null);
      expect(useAppStore.getState().activeThread).toBeNull();
    });

    test('clears on fetch error', async () => {
      const error: DomainError = { type: 'NOT_FOUND', message: 'Not found' };
      mockApi.getThread.mockReturnValueOnce(errAsync(error) as any);

      await useAppStore.getState().selectThread('nonexistent');
      expect(useAppStore.getState().activeThread).toBeNull();
      expect(useAppStore.getState().selectedThreadId).toBeNull();
    });
  });

  describe('setReviewPaneOpen', () => {
    test('opens review pane', () => {
      useAppStore.getState().setReviewPaneOpen(true);
      expect(useAppStore.getState().reviewPaneOpen).toBe(true);
    });

    test('closes review pane', () => {
      useAppStore.setState({ reviewPaneOpen: true });
      useAppStore.getState().setReviewPaneOpen(false);
      expect(useAppStore.getState().reviewPaneOpen).toBe(false);
    });
  });

  describe('startNewThread / cancelNewThread', () => {
    test('startNewThread sets newThreadProjectId', () => {
      useAppStore.getState().startNewThread('p1');
      expect(useAppStore.getState().newThreadProjectId).toBe('p1');
      expect(useAppStore.getState().selectedProjectId).toBe('p1');
      expect(useAppStore.getState().activeThread).toBeNull();
    });

    test('cancelNewThread clears newThreadProjectId', () => {
      useAppStore.setState({ newThreadProjectId: 'p1' });
      useAppStore.getState().cancelNewThread();
      expect(useAppStore.getState().newThreadProjectId).toBeNull();
    });
  });

  describe('archiveThread', () => {
    test('removes thread from list and clears selection', async () => {
      mockApi.archiveThread.mockReturnValueOnce(okAsync({}) as any);

      useAppStore.setState({
        selectedThreadId: 't1',
        activeThread: { id: 't1' } as any,
        threadsByProject: {
          p1: [
            { id: 't1', projectId: 'p1' } as any,
            { id: 't2', projectId: 'p1' } as any,
          ],
        },
      });

      await useAppStore.getState().archiveThread('t1', 'p1');
      expect(useAppStore.getState().threadsByProject['p1']).toHaveLength(1);
      expect(useAppStore.getState().selectedThreadId).toBeNull();
      expect(useAppStore.getState().activeThread).toBeNull();
    });
  });

  describe('appendOptimisticMessage', () => {
    test('adds user message to active thread', () => {
      useAppStore.setState({
        activeThread: {
          id: 't1',
          projectId: 'p1',
          messages: [],
          status: 'completed',
        } as any,
        threadsByProject: {
          p1: [{ id: 't1', status: 'completed' } as any],
        },
      });

      useAppStore.getState().appendOptimisticMessage('t1', 'Hello agent');

      const state = useAppStore.getState();
      expect(state.activeThread!.messages).toHaveLength(1);
      expect(state.activeThread!.messages[0].content).toBe('Hello agent');
      expect(state.activeThread!.messages[0].role).toBe('user');
      expect(state.activeThread!.status).toBe('running');
    });

    test('does nothing if threadId does not match active thread', () => {
      useAppStore.setState({
        activeThread: { id: 't1', messages: [] } as any,
      });

      useAppStore.getState().appendOptimisticMessage('t2', 'Hello');
      expect(useAppStore.getState().activeThread!.messages).toHaveLength(0);
    });
  });

  describe('WebSocket event handlers', () => {
    describe('handleWSMessage', () => {
      test('adds new message to active thread', () => {
        useAppStore.setState({
          activeThread: { id: 't1', messages: [] } as any,
        });

        useAppStore.getState().handleWSMessage('t1', {
          messageId: 'msg1',
          role: 'assistant',
          content: 'Hello',
        });

        const messages = useAppStore.getState().activeThread!.messages;
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe('Hello');
        expect(messages[0].id).toBe('msg1');
      });

      test('updates existing message by messageId', () => {
        useAppStore.setState({
          activeThread: {
            id: 't1',
            messages: [
              { id: 'msg1', threadId: 't1', role: 'assistant', content: 'Partial', timestamp: '' },
            ],
          } as any,
        });

        useAppStore.getState().handleWSMessage('t1', {
          messageId: 'msg1',
          role: 'assistant',
          content: 'Partial content complete',
        });

        const messages = useAppStore.getState().activeThread!.messages;
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe('Partial content complete');
      });

      test('ignores messages for different thread', () => {
        useAppStore.setState({
          activeThread: { id: 't1', messages: [] } as any,
        });

        useAppStore.getState().handleWSMessage('t2', {
          role: 'assistant',
          content: 'Hello',
        });

        expect(useAppStore.getState().activeThread!.messages).toHaveLength(0);
      });
    });

    describe('handleWSToolCall', () => {
      test('attaches tool call to last assistant message', () => {
        useAppStore.setState({
          activeThread: {
            id: 't1',
            messages: [
              { id: 'msg1', role: 'assistant', content: 'Using tool', toolCalls: [] },
            ],
          } as any,
        });

        useAppStore.getState().handleWSToolCall('t1', {
          messageId: 'msg1',
          name: 'Read',
          input: { file: 'test.ts' },
        });

        const msg = useAppStore.getState().activeThread!.messages[0];
        expect(msg.toolCalls).toHaveLength(1);
        expect(msg.toolCalls![0].name).toBe('Read');
      });

      test('creates placeholder assistant message when none exists', () => {
        useAppStore.setState({
          activeThread: { id: 't1', messages: [] } as any,
        });

        useAppStore.getState().handleWSToolCall('t1', {
          name: 'Edit',
          input: {},
        });

        const messages = useAppStore.getState().activeThread!.messages;
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('assistant');
        expect(messages[0].toolCalls).toHaveLength(1);
      });
    });

    describe('handleWSStatus', () => {
      test('updates thread status in threadsByProject', () => {
        useAppStore.setState({
          threadsByProject: {
            p1: [{ id: 't1', status: 'running' } as any],
          },
          activeThread: { id: 't1', status: 'running' } as any,
        });

        useAppStore.getState().handleWSStatus('t1', { status: 'completed' });

        expect(useAppStore.getState().threadsByProject['p1'][0].status).toBe('completed');
        expect(useAppStore.getState().activeThread!.status).toBe('completed');
      });
    });

    describe('handleWSResult', () => {
      test('updates thread cost and status to completed', () => {
        useAppStore.setState({
          threadsByProject: {
            p1: [{ id: 't1', status: 'running', cost: 0 } as any],
          },
          activeThread: { id: 't1', status: 'running', cost: 0 } as any,
        });

        useAppStore.getState().handleWSResult('t1', { cost: 0.05 });

        expect(useAppStore.getState().activeThread!.status).toBe('completed');
        expect(useAppStore.getState().activeThread!.cost).toBe(0.05);
      });
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe('Edge cases', () => {
    test('handleWSResult without cost uses existing cost', () => {
      useAppStore.setState({
        threadsByProject: {
          p1: [{ id: 't1', status: 'running', cost: 0.03 } as any],
        },
        activeThread: { id: 't1', status: 'running', cost: 0.03 } as any,
      });

      useAppStore.getState().handleWSResult('t1', {});

      expect(useAppStore.getState().activeThread!.cost).toBe(0.03);
      expect(useAppStore.getState().activeThread!.status).toBe('completed');
    });

    test('handleWSResult with cost=0 sets cost to 0', () => {
      useAppStore.setState({
        threadsByProject: {
          p1: [{ id: 't1', status: 'running', cost: 0.03 } as any],
        },
        activeThread: { id: 't1', status: 'running', cost: 0.03 } as any,
      });

      useAppStore.getState().handleWSResult('t1', { cost: 0 });

      expect(useAppStore.getState().activeThread!.cost).toBe(0);
    });

    test('handleWSStatus does not crash when threadsByProject is empty', () => {
      useAppStore.setState({
        threadsByProject: {},
        activeThread: null,
      });

      // Should not throw
      useAppStore.getState().handleWSStatus('t1', { status: 'completed' });
      expect(useAppStore.getState().threadsByProject).toEqual({});
    });

    test('handleWSMessage without messageId generates a UUID', () => {
      useAppStore.setState({
        activeThread: { id: 't1', messages: [] } as any,
      });

      useAppStore.getState().handleWSMessage('t1', {
        role: 'assistant',
        content: 'No messageId',
      });

      const messages = useAppStore.getState().activeThread!.messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBeTruthy();
      expect(typeof messages[0].id).toBe('string');
    });

    test('rapid sequential handleWSMessage events', () => {
      useAppStore.setState({
        activeThread: { id: 't1', messages: [] } as any,
      });

      // Simulate rapid streaming updates with same messageId
      for (let i = 1; i <= 10; i++) {
        useAppStore.getState().handleWSMessage('t1', {
          messageId: 'stream-msg',
          role: 'assistant',
          content: 'x'.repeat(i * 100),
        });
      }

      const messages = useAppStore.getState().activeThread!.messages;
      // Should still be 1 message (all updates to same messageId)
      expect(messages).toHaveLength(1);
      expect(messages[0].content.length).toBe(1000);
    });

    test('handleWSToolCall attaches to last assistant, not first', () => {
      useAppStore.setState({
        activeThread: {
          id: 't1',
          messages: [
            { id: 'msg1', role: 'assistant', content: 'First', toolCalls: [] },
            { id: 'msg2', role: 'user', content: 'Follow up' },
            { id: 'msg3', role: 'assistant', content: 'Second', toolCalls: [] },
          ],
        } as any,
      });

      useAppStore.getState().handleWSToolCall('t1', {
        messageId: 'msg3',
        name: 'Read',
        input: { file: 'test.ts' },
      });

      const messages = useAppStore.getState().activeThread!.messages;
      expect(messages[0].toolCalls).toHaveLength(0);  // First assistant untouched
      expect(messages[2].toolCalls).toHaveLength(1);   // Last assistant gets the tool call
    });

    test('handleWSToolCall with multiple tools on same message', () => {
      useAppStore.setState({
        activeThread: {
          id: 't1',
          messages: [
            { id: 'msg1', role: 'assistant', content: 'Working', toolCalls: [] },
          ],
        } as any,
      });

      useAppStore.getState().handleWSToolCall('t1', { messageId: 'msg1', name: 'Read', input: {} });
      useAppStore.getState().handleWSToolCall('t1', { messageId: 'msg1', name: 'Edit', input: {} });
      useAppStore.getState().handleWSToolCall('t1', { messageId: 'msg1', name: 'Bash', input: {} });

      const msg = useAppStore.getState().activeThread!.messages[0];
      expect(msg.toolCalls).toHaveLength(3);
      expect(msg.toolCalls!.map((tc: any) => tc.name)).toEqual(['Read', 'Edit', 'Bash']);
    });

    test('appendOptimisticMessage also updates threadsByProject status', () => {
      useAppStore.setState({
        activeThread: {
          id: 't1',
          projectId: 'p1',
          messages: [],
          status: 'completed',
        } as any,
        threadsByProject: {
          p1: [{ id: 't1', status: 'completed' } as any],
        },
      });

      useAppStore.getState().appendOptimisticMessage('t1', 'New task');

      const threadInList = useAppStore.getState().threadsByProject['p1'][0];
      expect(threadInList.status).toBe('running');
    });

    test('archiveThread does not clear selection for different thread', async () => {
      mockApi.archiveThread.mockReturnValueOnce(okAsync({}) as any);

      useAppStore.setState({
        selectedThreadId: 't2',
        activeThread: { id: 't2' } as any,
        threadsByProject: {
          p1: [
            { id: 't1', projectId: 'p1' } as any,
            { id: 't2', projectId: 'p1' } as any,
          ],
        },
      });

      await useAppStore.getState().archiveThread('t1', 'p1');
      expect(useAppStore.getState().selectedThreadId).toBe('t2');
      expect(useAppStore.getState().activeThread).toBeTruthy();
    });

    test('refreshActiveThread does nothing when no active thread', async () => {
      useAppStore.setState({ activeThread: null });
      await useAppStore.getState().refreshActiveThread();
      expect(useAppStore.getState().activeThread).toBeNull();
    });

    test('refreshActiveThread silently handles API error', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'Server down' };
      mockApi.getThread.mockReturnValueOnce(errAsync(error) as any);

      useAppStore.setState({
        activeThread: { id: 't1', messages: [] } as any,
      });

      // Should not throw
      await useAppStore.getState().refreshActiveThread();
    });

    test('selectProject does not reload threads if already loaded', () => {
      useAppStore.setState({
        expandedProjects: new Set(['p1']),
        threadsByProject: { p1: [{ id: 't1' } as any] },
      });

      useAppStore.getState().selectProject('p1');
      // listThreads should NOT be called since threads are already loaded
      expect(mockApi.listThreads).not.toHaveBeenCalled();
    });

    test('toggleProject loads threads on first expand', () => {
      mockApi.listThreads.mockReturnValueOnce(okAsync([]) as any);

      useAppStore.getState().toggleProject('p1');
      expect(mockApi.listThreads).toHaveBeenCalledWith('p1');
    });

    test('toggleProject does not reload threads on re-expand', () => {
      useAppStore.setState({
        threadsByProject: { p1: [] },
        expandedProjects: new Set(),
      });

      useAppStore.getState().toggleProject('p1');
      expect(mockApi.listThreads).not.toHaveBeenCalled();
    });
  });
});
