import type { Automation, Job, Watcher } from '@funny/shared';
import { screen } from '@testing-library/react';

/**
 * Complete fixtures for the lib and data tests: every required field has a
 * plausible default, so a fixture names only what it is about and needs no
 * cast. Overrides win.
 */

const CREATED_AT = '2026-01-01T00:00:00.000Z';

export function buildAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    projectId: 'p1',
    userId: 'u1',
    name: 'Automation',
    prompt: 'Check the build',
    schedule: '0 9 * * *',
    provider: 'claude',
    model: 'sonnet',
    mode: 'local',
    permissionMode: 'plan',
    enabled: true,
    maxRunHistory: 20,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    threadId: 't1',
    userId: 'u1',
    command: 'bun test',
    cwd: null,
    label: null,
    pid: null,
    logPath: '/tmp/job.log',
    exitPath: '/tmp/job.exit',
    status: 'running',
    exitCode: null,
    startedAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function buildWatcher(overrides: Partial<Watcher> = {}): Watcher {
  return {
    id: 'w1',
    threadId: 't1',
    userId: 'u1',
    key: 'watch',
    label: 'Watch',
    nextWakeAt: 0,
    lastDelayMs: 60_000,
    wakeCount: 0,
    maxWakes: 20,
    deadline: null,
    status: 'pending',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** `screen.getByTestId`, checked to be an element of `type` (an `<img>`, a `<video>`). */
export function getByTestIdOfType<T extends Element>(testId: string, type: new () => T): T {
  const element = screen.getByTestId(testId);
  if (!(element instanceof type)) throw new Error(`${testId} is not a ${type.name}`);
  return element;
}
