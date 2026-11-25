import { describe, expect, mock, test, vi } from 'bun:test';

import { renderHook, waitFor } from '@testing-library/react';

mock.module('@/data/runner/hooks', () => ({
  useProjectSandbox: () => ({ loading: false, sandbox: null }),
}));
mock.module('@/hooks/use-unified-prompt-model-groups', () => ({
  useUnifiedPromptModelGroups: () => [
    { label: 'Claude', models: [{ value: 'claude:sonnet', label: 'Sonnet' }] },
    { label: 'Codex', models: [{ value: 'codex:gpt-5', label: 'GPT-5' }] },
  ],
}));

import { usePromptSelection } from '@/hooks/use-prompt-model-state';

interface Props {
  isNewThread: boolean;
  provider: string;
  model: string;
  threadMode: string | null;
}

function render(initialProps: Props, updateThreadPermissionMode = vi.fn(async () => true)) {
  const view = renderHook(
    ({ isNewThread, provider, model, threadMode }: Props) =>
      usePromptSelection({
        isNewThread,
        effectiveThreadId: isNewThread ? undefined : 't1',
        project: {
          resolvedProjectId: 'p1',
          defaultProvider: 'claude',
          defaultModel: 'sonnet',
          defaultEffort: 'high',
          defaultPermissionMode: 'ask',
          defaultThreadMode: 'local',
        },
        active: {
          activeThreadProvider: isNewThread ? null : provider,
          activeThreadModel: isNewThread ? null : model,
          activeThreadLastEffort: null,
          activeThreadRuntime: 'local',
          activeThreadPermissionMode: threadMode,
          updateThreadPermissionMode,
        },
      }),
    { initialProps },
  );
  return { ...view, updateThreadPermissionMode };
}

describe('composer permission mode', () => {
  test("starts on the thread's mode, and on the project default for a new thread", () => {
    const view = render({
      isNewThread: false,
      provider: 'claude',
      model: 'sonnet',
      threadMode: 'plan',
    });
    expect(view.result.current.permission.mode).toBe('plan');
    view.rerender({ isNewThread: true, provider: 'claude', model: 'sonnet', threadMode: null });
    expect(view.result.current.permission.mode).toBe('ask');
  });

  test('auto falls back to autoEdit on a non-Claude provider and the thread saves it once', async () => {
    const view = render({
      isNewThread: false,
      provider: 'claude',
      model: 'sonnet',
      threadMode: 'auto',
    });
    expect(view.result.current.permission.mode).toBe('auto');
    expect(view.updateThreadPermissionMode).not.toHaveBeenCalled();

    view.rerender({ isNewThread: false, provider: 'codex', model: 'gpt-5', threadMode: 'auto' });
    expect(view.result.current.permission.mode).toBe('autoEdit');
    await waitFor(() => expect(view.updateThreadPermissionMode).toHaveBeenCalledTimes(1));
    expect(view.updateThreadPermissionMode).toHaveBeenCalledWith('t1', 'autoEdit');
  });
});
