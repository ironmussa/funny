/**
 * The tool rail (openspec `tool-panels`): one icon per available panel from
 * the registry, which opens, switches and closes the right panel, plus the
 * browser toggle, which scratch threads have too.
 */

import { beforeEach, describe, expect, test, mock } from 'bun:test';

import type { Thread } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { ToolRail } from '@/components/tool-rail/ToolRail';
import { buildThreadWithMessages, withThreadIndex } from '@/data/threads/testing';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { renderWithProviders } from '../helpers/render';

function seedThread(thread: Partial<Thread>) {
  const full = buildThreadWithMessages({
    id: 't1',
    projectId: 'p1',
    status: 'idle',
    title: 'T',
    ...thread,
  });
  useThreadStore.setState(
    withThreadIndex({
      threadsById: { [full.id]: full },
      threadIdsByProject: full.isScratch ? {} : { p1: [full.id] },
      scratchThreadIds: full.isScratch ? [full.id] : [],
      activeThread: full,
    }),
  );
  useProjectStore.setState({ selectedProjectId: full.isScratch ? null : 'p1' });
}

describe('ToolRail', () => {
  beforeEach(() => {
    useBrowserPanelStore.getState().reset();
    useUIStore.setState({ openPanels: {}, liveColumnsOpen: false });
  });

  test('opens, switches and closes the right panel', () => {
    seedThread({});
    renderWithProviders(<ToolRail />, { threadId: 't1' });

    fireEvent.click(screen.getByTestId('tool-rail-files'));
    expect(useUIStore.getState().openPanels.right).toBe('files');
    expect(screen.getByTestId('tool-rail-files')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('tool-rail-activity'));
    expect(useUIStore.getState().openPanels.right).toBe('activity');
    expect(screen.getByTestId('tool-rail-files')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('tool-rail-activity'));
    expect(useUIStore.getState().openPanels.right).toBeUndefined();
  });

  test('toggles the browser panel', () => {
    seedThread({});
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    const button = screen.getByTestId('tool-rail-browser');
    fireEvent.click(button);
    expect(useBrowserPanelStore.getState().open).toBe(true);
    fireEvent.click(button);
    expect(useBrowserPanelStore.getState().open).toBe(false);
  });

  test('a scratch thread has the browser but no review, files, tests or terminal', () => {
    seedThread({ id: 's1', projectId: '', isScratch: true });
    renderWithProviders(<ToolRail />, { threadId: 's1' });
    expect(screen.getByTestId('tool-rail-browser')).toBeInTheDocument();
    expect(screen.getByTestId('tool-rail-activity')).toBeInTheDocument();
    for (const id of ['review', 'files', 'tests', 'terminal']) {
      expect(screen.queryByTestId(`tool-rail-${id}`)).toBeNull();
    }
  });
});
