import { describe, test, expect, beforeEach } from 'vitest';

import { useReviewPaneStore } from '@/stores/review-pane-store';

describe('useReviewPaneStore', () => {
  beforeEach(() => {
    useReviewPaneStore.setState({
      dirtySignal: 0,
      dirtyThreadId: null,
      generatingCommitMsg: {},
    });
  });

  describe('initial state', () => {
    test('dirtySignal is 0', () => {
      expect(useReviewPaneStore.getState().dirtySignal).toBe(0);
    });

    test('dirtyThreadId is null', () => {
      expect(useReviewPaneStore.getState().dirtyThreadId).toBeNull();
    });
  });

  describe('notifyDirty', () => {
    test('increments dirtySignal by 1', () => {
      useReviewPaneStore.getState().notifyDirty('thread-1');
      expect(useReviewPaneStore.getState().dirtySignal).toBe(1);
    });

    test('sets dirtyThreadId to the given threadId', () => {
      useReviewPaneStore.getState().notifyDirty('thread-abc');
      expect(useReviewPaneStore.getState().dirtyThreadId).toBe('thread-abc');
    });

    test('multiple calls increment monotonically', () => {
      useReviewPaneStore.getState().notifyDirty('thread-1');
      expect(useReviewPaneStore.getState().dirtySignal).toBe(1);

      useReviewPaneStore.getState().notifyDirty('thread-1');
      expect(useReviewPaneStore.getState().dirtySignal).toBe(2);

      useReviewPaneStore.getState().notifyDirty('thread-1');
      expect(useReviewPaneStore.getState().dirtySignal).toBe(3);
    });

    test('updates threadId on each call', () => {
      useReviewPaneStore.getState().notifyDirty('thread-1');
      expect(useReviewPaneStore.getState().dirtyThreadId).toBe('thread-1');

      useReviewPaneStore.getState().notifyDirty('thread-2');
      expect(useReviewPaneStore.getState().dirtyThreadId).toBe('thread-2');

      useReviewPaneStore.getState().notifyDirty('thread-3');
      expect(useReviewPaneStore.getState().dirtyThreadId).toBe('thread-3');
    });

    test('different threads still increment the same counter', () => {
      useReviewPaneStore.getState().notifyDirty('thread-1');
      useReviewPaneStore.getState().notifyDirty('thread-2');
      useReviewPaneStore.getState().notifyDirty('thread-3');
      expect(useReviewPaneStore.getState().dirtySignal).toBe(3);
    });

    test('signal is always increasing (never decreases)', () => {
      const signals: number[] = [];
      for (let i = 0; i < 10; i++) {
        useReviewPaneStore.getState().notifyDirty(`thread-${i}`);
        signals.push(useReviewPaneStore.getState().dirtySignal);
      }
      for (let i = 1; i < signals.length; i++) {
        expect(signals[i]).toBeGreaterThan(signals[i - 1]);
      }
    });

    test('last threadId wins after multiple calls', () => {
      useReviewPaneStore.getState().notifyDirty('first');
      useReviewPaneStore.getState().notifyDirty('second');
      useReviewPaneStore.getState().notifyDirty('last');
      expect(useReviewPaneStore.getState().dirtyThreadId).toBe('last');
    });
  });

  describe('setGeneratingCommitMsg', () => {
    test('sets generating flag for a draft id', () => {
      useReviewPaneStore.getState().setGeneratingCommitMsg('thread-1', true);
      expect(useReviewPaneStore.getState().generatingCommitMsg).toEqual({ 'thread-1': true });
    });

    test('clears generating flag without affecting other drafts', () => {
      useReviewPaneStore.getState().setGeneratingCommitMsg('thread-1', true);
      useReviewPaneStore.getState().setGeneratingCommitMsg('thread-2', true);
      useReviewPaneStore.getState().setGeneratingCommitMsg('thread-1', false);

      expect(useReviewPaneStore.getState().generatingCommitMsg).toEqual({ 'thread-2': true });
    });
  });
});
