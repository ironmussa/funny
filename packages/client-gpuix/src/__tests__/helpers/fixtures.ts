import type { Message, Project, Thread, ToolCall } from '@funny/shared';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

const FIXTURE_TIMESTAMP = '2026-08-30T10:00:00.000Z';

/** A complete project row: every required field has a default, tests override what they read. */
export function buildProject(overrides: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    name: 'Project',
    path: '/repo',
    userId: 'u1',
    sortOrder: 0,
    createdAt: FIXTURE_TIMESTAMP,
    ...overrides,
  };
}

/** A complete thread row: every required field has a default, tests override what they read. */
export function buildThread(overrides: Partial<Thread> & Pick<Thread, 'id'>): Thread {
  return {
    projectId: 'p1',
    userId: 'u1',
    title: overrides.id,
    mode: 'local',
    status: 'idle',
    stage: 'in_progress',
    provider: 'claude',
    permissionMode: 'ask',
    model: 'opus-4.8',
    cost: 0,
    source: 'web',
    runtime: 'local',
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...overrides,
  };
}

/** A complete message row: every required field has a default, tests override what they read. */
export function buildMessage(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    threadId: 't1',
    role: 'assistant',
    content: '',
    timestamp: FIXTURE_TIMESTAMP,
    ...overrides,
  };
}

/** A complete tool call row: every required field has a default, tests override what they read. */
export function buildToolCall(overrides: Partial<ToolCall> & Pick<ToolCall, 'id'>): ToolCall {
  return {
    messageId: 'm1',
    name: 'Tool',
    input: '{}',
    ...overrides,
  };
}

/** Narrows a rendered node to an element with the props the test reads; fails the test otherwise. */
export function expectElement<P>(node: ReactNode): ReactElement<P> {
  if (!isValidElement<P>(node)) throw new Error('Expected a React element');
  return node;
}
