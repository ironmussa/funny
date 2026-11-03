/**
 * The thread header has a visible Browser button that toggles the browser
 * panel, for scratch threads too.
 */

import type { Thread } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { ThreadHeaderActionsBase } from '@/components/thread/header/ThreadHeaderActions';
import { withThreadIndex } from '@/data/threads/testing';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useThreadStore } from '@/stores/thread-store';

import { renderWithProviders } from '../helpers/render';

function seedThread(thread: Partial<Thread>) {
  const full = { id: 't1', projectId: 'p1', status: 'idle', title: 'T', ...thread } as Thread;
  useThreadStore.setState(
    withThreadIndex({
      threadsById: { [full.id]: full },
      threadIdsByProject: full.isScratch ? {} : { p1: [full.id] },
      scratchThreadIds: full.isScratch ? [full.id] : [],
      activeThread: full as any,
    }),
  );
}

describe('header Browser button', () => {
  beforeEach(() => {
    useBrowserPanelStore.getState().reset();
  });

  test('toggles the browser panel', () => {
    seedThread({});
    renderWithProviders(<ThreadHeaderActionsBase />, { threadId: 't1' });
    const button = screen.getByTestId('header-toggle-browser');
    fireEvent.click(button);
    expect(useBrowserPanelStore.getState().open).toBe(true);
    fireEvent.click(button);
    expect(useBrowserPanelStore.getState().open).toBe(false);
  });

  test('is available on scratch threads', () => {
    seedThread({ id: 's1', projectId: '', isScratch: true });
    renderWithProviders(<ThreadHeaderActionsBase />, { threadId: 's1' });
    expect(screen.getByTestId('header-toggle-browser')).toBeInTheDocument();
  });
});
