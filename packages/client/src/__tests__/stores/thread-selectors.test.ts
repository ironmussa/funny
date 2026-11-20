import type { ThreadStatus } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import { buildThreadWithMessages } from '@/data/threads/testing';
import {
  selectLastMessage,
  selectFirstMessage,
  selectLastMessageToolCallCount,
  selectIsTerminal,
} from '@/stores/thread-selectors';

import { buildMessage, buildToolCall } from '../helpers/builders-stores';

const firstMessage = buildMessage({
  id: 'm1',
  content: 'hello',
  toolCalls: [buildToolCall({ id: 'tc1' })],
});
const lastMessage = buildMessage({ id: 'm2', content: 'world', toolCalls: [] });

const mockThread = buildThreadWithMessages({
  messages: [firstMessage, lastMessage],
  status: 'running',
});

const mockThreadSingleMessage = buildThreadWithMessages({
  messages: [
    buildMessage({
      id: 'm1',
      content: 'only one',
      toolCalls: [buildToolCall({ id: 'tc1' }), buildToolCall({ id: 'tc2' })],
    }),
  ],
  status: 'idle',
});

const mockThreadEmptyMessages = buildThreadWithMessages({
  messages: [],
  status: 'idle',
});

const withStatus = (status: ThreadStatus) => ({ ...mockThread, status });

describe('selectLastMessage', () => {
  test('returns last message from thread', () => {
    const result = selectLastMessage(mockThread);
    expect(result).toEqual(lastMessage);
  });

  test('returns the only message when there is one', () => {
    const result = selectLastMessage(mockThreadSingleMessage);
    expect(result?.id).toBe('m1');
  });

  test('returns undefined for null thread', () => {
    expect(selectLastMessage(null)).toBeUndefined();
  });

  test('returns undefined for empty messages array', () => {
    expect(selectLastMessage(mockThreadEmptyMessages)).toBeUndefined();
  });
});

describe('selectFirstMessage', () => {
  test('returns first message from thread', () => {
    const result = selectFirstMessage(mockThread);
    expect(result).toEqual(firstMessage);
  });

  test('returns undefined for null thread', () => {
    expect(selectFirstMessage(null)).toBeUndefined();
  });

  test('returns undefined for empty messages array', () => {
    expect(selectFirstMessage(mockThreadEmptyMessages)).toBeUndefined();
  });
});

describe('selectLastMessageToolCallCount', () => {
  test('returns count of last message tool calls', () => {
    expect(selectLastMessageToolCallCount(mockThread)).toBe(0);
  });

  test('returns non-zero count when last message has tool calls', () => {
    expect(selectLastMessageToolCallCount(mockThreadSingleMessage)).toBe(2);
  });

  test('returns 0 for null thread', () => {
    expect(selectLastMessageToolCallCount(null)).toBe(0);
  });

  test('returns 0 for empty messages array', () => {
    expect(selectLastMessageToolCallCount(mockThreadEmptyMessages)).toBe(0);
  });
});

describe('selectIsTerminal', () => {
  test('returns true for completed status', () => {
    expect(selectIsTerminal(withStatus('completed'))).toBe(true);
  });

  test('returns true for failed status', () => {
    expect(selectIsTerminal(withStatus('failed'))).toBe(true);
  });

  test('returns true for stopped status', () => {
    expect(selectIsTerminal(withStatus('stopped'))).toBe(true);
  });

  test('returns true for interrupted status', () => {
    expect(selectIsTerminal(withStatus('interrupted'))).toBe(true);
  });

  test('returns false for running status', () => {
    expect(selectIsTerminal(mockThread)).toBe(false);
  });

  test('returns false for idle status', () => {
    expect(selectIsTerminal(withStatus('idle'))).toBe(false);
  });

  test('returns false for queued status', () => {
    const unknownStatus: string = 'queued';
    // SAFETY: 'queued' is deliberately not a ThreadStatus; the test checks an unknown status is not terminal.
    const queued = withStatus(unknownStatus as ThreadStatus);
    expect(selectIsTerminal(queued)).toBe(false);
  });

  test('returns true for null thread', () => {
    expect(selectIsTerminal(null)).toBe(true);
  });
});
