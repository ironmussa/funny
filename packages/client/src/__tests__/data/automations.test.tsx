import type { Automation, AutomationRun, InboxItem, Thread } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createAutomation,
  deleteAutomation,
  triageRun,
  updateAutomation,
} from '@/data/automations/actions';
import { handleRunCompleted } from '@/data/automations/events';
import { useAutomationInbox, useProjectAutomations } from '@/data/automations/hooks';
import { loadAutomations, loadInbox } from '@/data/automations/loaders';
import { getAutomationsData, getInboxData } from '@/data/automations/store';
import { seedAutomations } from '@/data/automations/testing';
import { seedProjectThreads } from '@/data/threads/testing';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  triggerAutomation: vi.fn(),
  listAutomationRuns: vi.fn(),
  getAutomationInbox: vi.fn(),
  triageRun: vi.fn(),
}));
vi.mock('@/lib/api/automations', () => ({ automationsApi: api }));

const effects = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects } },
}));

const automation = (id: string, overrides: Partial<Automation> = {}) =>
  ({ id, projectId: 'p1', name: id, enabled: true, ...overrides }) as Automation;
const run = (id: string, overrides: Partial<AutomationRun> = {}): AutomationRun => ({
  id,
  automationId: 'a1',
  threadId: 't1',
  status: 'completed',
  triageStatus: 'pending',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
  ...overrides,
});
const thread = { id: 't1', projectId: 'p1', title: 'run' } as Thread;
const item = (r: AutomationRun): InboxItem => ({ run: r, automation: automation('a1'), thread });
const failure: DomainError = { type: 'INTERNAL', message: 'boom' };

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('automations', () => {
  test("loading one project's automations leaves other projects alone", async () => {
    seedAutomations({
      automations: [automation('other', { projectId: 'p2' }), automation('gone')],
    });
    api.listAutomations.mockReturnValue(okAsync([automation('a1')]));
    await loadAutomations('p1');
    expect([...getAutomationsData().collection.keys()].sort()).toEqual(['a1', 'other']);
  });

  test('a created automation goes to the top of its project; a failed one toasts', async () => {
    seedAutomations({ automations: [automation('a1')] });
    api.createAutomation.mockReturnValueOnce(okAsync(automation('new')));
    await createAutomation({ projectId: 'p1' } as never);
    const { result } = renderHook(() => useProjectAutomations('p1'));
    await waitFor(() => expect(result.current.map((a) => a.id)).toEqual(['new', 'a1']));

    api.createAutomation.mockReturnValueOnce(errAsync(failure));
    expect((await createAutomation({ projectId: 'p1' } as never)).isErr()).toBe(true);
    expect(effects.emit).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  test('a refused edit rolls back; a confirmed delete removes the row', async () => {
    seedAutomations({ automations: [automation('a1')] });
    const gate = deferred<void>();
    api.updateAutomation.mockReturnValue(
      new ResultAsync(gate.promise.then(() => errAsync<Automation, DomainError>(failure))),
    );
    const pending = updateAutomation('a1', { enabled: false });
    expect(getAutomationsData().read('a1')?.enabled).toBe(false);
    gate.resolve();
    await pending;
    expect(getAutomationsData().read('a1')?.enabled).toBe(true);

    api.deleteAutomation.mockReturnValue(okAsync({ ok: true }));
    await deleteAutomation('a1');
    expect(getAutomationsData().read('a1')).toBeUndefined();
  });
});

describe('inbox', () => {
  test('counts pending items; loads close together share one request', async () => {
    api.getAutomationInbox.mockReturnValue(
      okAsync([item(run('r1')), item(run('r2', { triageStatus: 'reviewed' }))]),
    );
    await Promise.all([loadInbox(), loadInbox()]);
    await loadInbox();
    expect(api.getAutomationInbox).toHaveBeenCalledTimes(1);
    const { result } = renderHook(() => useAutomationInbox());
    await waitFor(() => expect(result.current.inbox).toHaveLength(2));
    expect(result.current.pendingCount).toBe(1);
  });

  test('triage shows at once and rolls back when refused', async () => {
    seedAutomations({ inbox: [item(run('r1'))] });
    api.triageRun.mockReturnValue(errAsync(failure));
    const pending = triageRun('r1', 'reviewed');
    expect(getInboxData().read('r1')?.run.triageStatus).toBe('reviewed');
    await pending;
    expect(getInboxData().read('r1')?.run.triageStatus).toBe('pending');
  });

  test('a completed run joins the inbox from cached rows without a reload', () => {
    seedAutomations({ automations: [automation('a1')] });
    seedProjectThreads({ p1: [thread] });
    handleRunCompleted({ automationId: 'a1', runId: 'r9', threadId: 't1', hasFindings: true });
    expect(getInboxData().getSynced('r9')?.run).toMatchObject({ status: 'completed' });
    expect(api.getAutomationInbox).not.toHaveBeenCalled();
  });

  test('without the automation or thread cached, a completed run reloads the inbox', () => {
    api.getAutomationInbox.mockReturnValue(okAsync([]));
    handleRunCompleted({ automationId: 'a1', runId: 'r9', threadId: 't1', hasFindings: false });
    expect(api.getAutomationInbox).toHaveBeenCalledTimes(1);
  });
});
