import { describe, expect, mock, test, vi } from 'bun:test';

import { act, renderHook } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';

import { useSaveBacklogOnLeave } from '@/hooks/use-save-backlog-on-leave';

import { mockT } from '../helpers/mock-i18n';

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function setup(onDraftLeft: () => void) {
  window.history.replaceState(null, '', '/projects/p1/new');
  return renderHook(
    () => {
      const hasContentRef = useRef(true);
      const latestPromptTextRef = useRef('half-written prompt');
      const justSubmittedRef = useRef(false);
      return {
        ...useSaveBacklogOnLeave({
          effectiveProjectId: 'p1',
          defaultThreadMode: 'local',
          latestPromptTextRef,
          hasContentRef,
          justSubmittedRef,
          onDraftLeft,
        }),
        hasContentRef,
        navigate: useNavigate(),
        location: useLocation(),
      };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => <BrowserRouter>{children}</BrowserRouter>,
    },
  );
}

describe('useSaveBacklogOnLeave', () => {
  test('a discarded prompt does not block the next navigation', async () => {
    const onDraftLeft = vi.fn();
    const { result, unmount } = setup(onDraftLeft);

    act(() => result.current.navigate('/projects/p1/settings'));
    expect(result.current.blocker.state).toBe('blocked');

    act(() => result.current.handleDiscard());
    expect(onDraftLeft).toHaveBeenCalledTimes(1);
    expect(result.current.hasContentRef.current).toBe(false);
    expect(result.current.location.pathname).toBe('/projects/p1/settings');

    // Past the proceed tick, coming back must not ask again: the compose form
    // stays mounted under Settings, so its guard is still listening.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    act(() => result.current.navigate('/projects/p1/new'));
    expect(result.current.blocker.state).toBe('idle');
    expect(result.current.location.pathname).toBe('/projects/p1/new');
    unmount();
  });

  test('cancel keeps the prompt and stays put', () => {
    const onDraftLeft = vi.fn();
    const { result, unmount } = setup(onDraftLeft);

    act(() => result.current.navigate('/projects/p1/settings'));
    act(() => result.current.handleCancel());
    expect(onDraftLeft).not.toHaveBeenCalled();
    expect(result.current.hasContentRef.current).toBe(true);
    expect(result.current.location.pathname).toBe('/projects/p1/new');
    unmount();
  });
});
