import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  byProject: {} as Record<string, { enabledByDefault: boolean } | undefined>,
}));

vi.mock('@/data/runner/hooks', () => ({
  useProjectSandbox: (projectId: string | null | undefined) => {
    const configured = projectId ? state.byProject[projectId] : undefined;
    return {
      loading: false,
      sandbox: configured
        ? {
            settings: {
              projectId,
              connectionId: 'c1',
              sizeId: 'default',
              enabledByDefault: configured.enabledByDefault,
              updatedAt: '',
            },
            connection: { id: 'c1', label: 'InstaBox' },
          }
        : null,
    };
  },
}));

import { PromptFooterBar } from '@/components/prompt-input/PromptFooterBar';
import { useSandboxToggle } from '@/hooks/use-prompt-model-state';

beforeEach(() => {
  state.byProject = { p1: { enabledByDefault: true }, p2: { enabledByDefault: false } };
});

describe('sandbox toggle (project-sandboxes)', () => {
  test('starts at the project default, labeled with the connection', () => {
    const { result } = renderHook(() => useSandboxToggle('p1', true));
    expect(result.current).toMatchObject({ label: 'InstaBox', enabled: true });
    const off = renderHook(() => useSandboxToggle('p2', true));
    expect(off.result.current?.enabled).toBe(false);
  });

  test('a choice holds for its project only', () => {
    const { result, rerender } = renderHook(({ id }) => useSandboxToggle(id, true), {
      initialProps: { id: 'p1' },
    });
    act(() => result.current!.setEnabled(false));
    expect(result.current?.enabled).toBe(false);
    rerender({ id: 'p2' });
    expect(result.current?.enabled).toBe(false);
    rerender({ id: 'p1' });
    expect(result.current?.enabled).toBe(false);
    act(() => result.current!.setEnabled(true));
    rerender({ id: 'p2' });
    // p2 was never touched: its default (off) applies.
    expect(result.current?.enabled).toBe(false);
  });

  test('absent without a configuration, or when not offered (scratch, follow-up)', () => {
    expect(renderHook(() => useSandboxToggle('p3', true)).result.current).toBeNull();
    expect(renderHook(() => useSandboxToggle('p1', false)).result.current).toBeNull();
  });
});

describe('PromptFooterBar sandbox toggle', () => {
  const base = {
    isNewThread: true,
    runtimeModes: [
      { value: 'local', label: 'Local' },
      { value: 'remote', label: 'Remote' },
    ],
    runtime: 'local',
    onRuntimeChange: vi.fn(),
    onRequestCompact: vi.fn(),
  };

  test('when on it replaces the runtime selector; turning it off shows it again', () => {
    const setEnabled = vi.fn();
    const { rerender } = render(
      <PromptFooterBar
        {...base}
        sandboxToggle={{ label: 'InstaBox', enabled: true, setEnabled }}
      />,
    );
    const toggle = screen.getByTestId('prompt-sandbox-toggle');
    expect(toggle).toHaveTextContent('Sandbox · InstaBox');
    expect(toggle).toHaveAttribute('data-state', 'on');
    expect(screen.queryByTestId('prompt-mode-select')).toBeNull();

    fireEvent.click(toggle);
    expect(setEnabled).toHaveBeenCalledWith(false);

    rerender(
      <PromptFooterBar
        {...base}
        sandboxToggle={{ label: 'InstaBox', enabled: false, setEnabled }}
      />,
    );
    expect(screen.getByTestId('prompt-mode-select')).toBeInTheDocument();
  });

  test('without a project sandbox there is no toggle', () => {
    render(<PromptFooterBar {...base} sandboxToggle={null} />);
    expect(screen.queryByTestId('prompt-sandbox-toggle')).toBeNull();
    expect(screen.getByTestId('prompt-mode-select')).toBeInTheDocument();
  });
});
