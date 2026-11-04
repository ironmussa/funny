import type { AgentTemplate } from '@funny/shared';
import { BUILTIN_AGENT_TEMPLATES } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  updateTemplate,
} from '@/data/templates/actions';
import { useAgentTemplates, useTemplateUsageStats } from '@/data/templates/hooks';
import { ensureTemplatesLoaded, loadTemplates } from '@/data/templates/loaders';
import { getTemplatesData } from '@/data/templates/store';
import { seedTemplates } from '@/data/templates/testing';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({
  listAgentTemplates: vi.fn(),
  createAgentTemplate: vi.fn(),
  updateAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  duplicateAgentTemplate: vi.fn(),
  getAgentTemplateUsageStats: vi.fn(),
}));
vi.mock('@/lib/api/agent-templates', () => ({ agentTemplatesApi: api }));

const effects = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects } },
}));

function template(id: string, overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    id,
    userId: 'u1',
    name: id,
    systemPromptMode: 'prepend',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const failure: DomainError = { type: 'INTERNAL', message: 'boom' };
const read = () => renderHook(() => useAgentTemplates());
const ids = (templates: AgentTemplate[]) => templates.map((t) => t.id);

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('loading templates', () => {
  test('user templates come first and built-ins last', async () => {
    api.listAgentTemplates.mockReturnValue(okAsync([template('mine')]));
    expect((await loadTemplates()).isOk()).toBe(true);
    const list = read();
    await waitFor(() =>
      expect(ids(list.result.current)).toEqual(['mine', ...ids(BUILTIN_AGENT_TEMPLATES)]),
    );
  });

  test('ensureTemplatesLoaded does not refetch a loaded list', async () => {
    seedTemplates([template('a')]);
    await ensureTemplatesLoaded();
    expect(api.listAgentTemplates).not.toHaveBeenCalled();
  });
});

describe('template writes', () => {
  beforeEach(() => seedTemplates([template('a', { name: 'Old' }), template('b')]));

  test('a created or duplicated template goes to the top', async () => {
    api.createAgentTemplate.mockReturnValue(okAsync(template('new')));
    api.duplicateAgentTemplate.mockReturnValue(okAsync(template('copy')));
    await createTemplate({ name: 'new' });
    await duplicateTemplate('a');
    const list = read();
    await waitFor(() => expect(ids(list.result.current)).toEqual(['copy', 'new', 'a', 'b']));
  });

  test('a failed create shows a toast and adds nothing', async () => {
    api.createAgentTemplate.mockReturnValue(errAsync(failure));
    expect((await createTemplate({ name: 'x' })).isErr()).toBe(true);
    expect(getTemplatesData().collection.size).toBe(2);
    expect(effects.emit).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  test('an edit shows at once and rolls back with a toast on failure', async () => {
    const gate = deferred<void>();
    api.updateAgentTemplate.mockReturnValue(
      new ResultAsync(gate.promise.then(() => errAsync<AgentTemplate, DomainError>(failure))),
    );
    const pending = updateTemplate('a', { name: 'New' });
    expect(getTemplatesData().read('a')?.name).toBe('New');
    gate.resolve();
    expect((await pending).isErr()).toBe(true);
    expect(getTemplatesData().read('a')?.name).toBe('Old');
    expect(effects.emit).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  test('a confirmed delete removes the template', async () => {
    api.deleteAgentTemplate.mockReturnValue(okAsync({ ok: true }));
    expect((await deleteTemplate('a')).isOk()).toBe(true);
    expect(getTemplatesData().read('a')).toBeUndefined();
  });
});

describe('useTemplateUsageStats', () => {
  test('two components share one request', async () => {
    api.getAgentTemplateUsageStats.mockReturnValue(okAsync({ a: 3 }));
    const first = renderHook(() => useTemplateUsageStats());
    const second = renderHook(() => useTemplateUsageStats());
    await waitFor(() => expect(first.result.current).toEqual({ a: 3 }));
    expect(second.result.current).toEqual({ a: 3 });
    expect(api.getAgentTemplateUsageStats).toHaveBeenCalledTimes(1);
  });
});
