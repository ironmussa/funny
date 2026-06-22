import { act, renderHook, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useSlashSkills } from '@/hooks/use-slash-skills';

const { listAgentResourcesMock } = vi.hoisted(() => ({
  listAgentResourcesMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { listAgentResources: listAgentResourcesMock },
}));

// Each model returns a distinct skill so we can assert the right one surfaced.
function resourcesForModel(model?: string) {
  const name = model === 'claude' ? 'query-logs' : 'other-skill';
  return okAsync({
    resources: [{ kind: 'skill' as const, name, description: '', scope: 'global' as const }],
  });
}

describe('useSlashSkills', () => {
  beforeEach(() => {
    listAgentResourcesMock.mockReset();
    listAgentResourcesMock.mockImplementation((opts: { model?: string }) =>
      resourcesForModel(opts.model),
    );
  });

  test('eager mode loads on mount', async () => {
    const { result } = renderHook(() =>
      useSlashSkills({ provider: 'codex', model: 'gpt', mode: 'eager' }),
    );

    await waitFor(() => expect(result.current.slashSkills).toHaveLength(1));
    expect(result.current.slashSkills[0]?.name).toBe('other-skill');
    expect(listAgentResourcesMock).toHaveBeenCalledTimes(1);
  });

  test('switching model re-fetches and replaces the cached list (regression)', async () => {
    const { result, rerender } = renderHook(
      ({ model }: { model: string }) => useSlashSkills({ provider: 'codex', model, mode: 'eager' }),
      { initialProps: { model: 'gpt' } },
    );

    await waitFor(() => expect(result.current.slashSkills[0]?.name).toBe('other-skill'));

    // Switch to a model whose resolver DOES include query-logs.
    rerender({ model: 'claude' });

    await waitFor(() => expect(result.current.slashSkills[0]?.name).toBe('query-logs'));
    expect(listAgentResourcesMock).toHaveBeenCalledTimes(2);
  });

  test('lazy mode does not fetch until ensureSlashSkills is called', async () => {
    const { result } = renderHook(() =>
      useSlashSkills({ provider: 'codex', model: 'gpt', mode: 'lazy' }),
    );

    // No eager fetch.
    expect(listAgentResourcesMock).not.toHaveBeenCalled();
    expect(result.current.slashSkills).toHaveLength(0);

    await act(async () => {
      await result.current.ensureSlashSkills();
    });

    await waitFor(() => expect(result.current.slashSkills).toHaveLength(1));
    expect(listAgentResourcesMock).toHaveBeenCalledTimes(1);
  });
});
