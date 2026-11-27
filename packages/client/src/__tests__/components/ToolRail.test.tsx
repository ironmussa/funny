/**
 * The tool rail (openspec `tool-panels`): one icon per available panel from
 * the registry, which opens, switches and closes the right panel, plus the
 * browser toggle, which scratch threads have too.
 */

import { beforeEach, describe, expect, test, mock } from 'bun:test';

import type { Thread } from '@funny/shared';
import { act, fireEvent, screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { ToolRail } from '@/components/tool-rail/ToolRail';
import { buildThreadWithMessages, withThreadIndex } from '@/data/threads/testing';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadHistoryStore } from '@/stores/thread-history-store';
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
    useUIStore.setState({
      openPanels: {},
      liveColumnsOpen: false,
      analyticsOpen: false,
      automationInboxOpen: false,
    });
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

  test('a scratch thread keeps every icon, with review, files, tests and terminal disabled', () => {
    seedThread({ id: 's1', projectId: '', isScratch: true });
    renderWithProviders(<ToolRail />, { threadId: 's1' });
    expect(screen.getByTestId('tool-rail-browser')).toBeEnabled();
    expect(screen.getByTestId('tool-rail-activity')).toBeEnabled();
    // Disabled, not removed: the rail has the same icons for every thread.
    for (const id of ['review', 'files', 'tests', 'terminal']) {
      expect(screen.getByTestId(`tool-rail-${id}`)).toBeDisabled();
    }
  });

  test('a thread still setting up keeps the rail, with its tools disabled', () => {
    seedThread({ status: 'setting_up' });
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    for (const id of ['review', 'files', 'comments', 'activity', 'tests', 'terminal', 'browser']) {
      expect(screen.getByTestId(`tool-rail-${id}`)).toBeDisabled();
    }
    expect(screen.getByTestId('tool-rail-threads')).toBeEnabled();
  });

  test('the factory button swaps the left sidebar to the factory and back', () => {
    seedThread({});
    useUIStore.setState({ leftPanelMode: 'threads' });
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    const button = screen.getByTestId('tool-rail-factory');

    fireEvent.click(button);
    expect(useUIStore.getState().leftPanelMode).toBe('factory');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    // The thread in the center is not touched.
    expect(useThreadStore.getState().activeThread?.id).toBe('t1');

    fireEvent.click(button);
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
  });

  test('the kanban button shows the board in the left sidebar and back', () => {
    seedThread({});
    useUIStore.setState({ leftPanelMode: 'threads' });
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    const kanban = screen.getByTestId('tool-rail-kanban');

    fireEvent.click(kanban);
    expect(useUIStore.getState().leftPanelMode).toBe('kanban');
    expect(kanban).toHaveAttribute('aria-pressed', 'true');
    expect(useThreadStore.getState().activeThread?.id).toBe('t1');

    fireEvent.click(kanban);
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
  });

  test('the threads button brings the thread list back from another view', () => {
    seedThread({});
    useUIStore.setState({ leftPanelMode: 'factory' });
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    const threads = screen.getByTestId('tool-rail-threads');
    expect(threads).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(threads);
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
    // Pressing it again keeps the thread list: it is the sidebar's home view.
    fireEvent.click(threads);
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
  });

  test('under a full-screen view the panel tools stay, disabled', () => {
    seedThread({});
    renderWithProviders(<ToolRail viewsOnly />, { threadId: 't1' });
    for (const id of ['threads', 'kanban', 'factory', 'grid', 'analytics']) {
      expect(screen.getByTestId(`tool-rail-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('tool-rail-tests')).toBeInTheDocument();
    // The panel tools keep their place, disabled, instead of disappearing.
    for (const id of ['review', 'files', 'comments', 'activity', 'terminal', 'browser']) {
      expect(screen.getByTestId(`tool-rail-${id}`)).toBeDisabled();
    }
  });

  test('the grid and analytics buttons show which full-screen page is open', () => {
    seedThread({});
    useUIStore.setState({ analyticsOpen: true });
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    expect(screen.getByTestId('tool-rail-analytics')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tool-rail-grid')).toHaveAttribute('aria-pressed', 'false');
  });

  test('the grid is its own view: no other view button stays lit', () => {
    seedThread({});
    useUIStore.setState({ leftPanelMode: 'threads', liveColumnsOpen: true });
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    expect(screen.getByTestId('tool-rail-grid')).toHaveAttribute('aria-pressed', 'true');
    for (const id of ['threads', 'kanban', 'factory']) {
      expect(screen.getByTestId(`tool-rail-${id}`)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  test('opening the grid sets its flag in the same click as its URL', () => {
    seedThread({});
    useUIStore.setState({ leftPanelMode: 'factory' });
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/projects/p1/threads/t1' },
    );

    fireEvent.click(screen.getByTestId('tool-rail-grid'));
    expect(screen.getByTestId('location')).toHaveTextContent('/grid');
    // No render where the URL is the grid's and the flag is still closed.
    expect(useUIStore.getState().liveColumnsOpen).toBe(true);
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
  });

  test('pressing the grid while it is shown does nothing', () => {
    seedThread({});
    useUIStore.setState({ leftPanelMode: 'threads', liveColumnsOpen: true });
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/grid' },
    );

    fireEvent.click(screen.getByTestId('tool-rail-grid'));
    expect(screen.getByTestId('location')).toHaveTextContent('/grid');
    expect(useUIStore.getState().liveColumnsOpen).toBe(true);
  });

  test('leaving the grid for the thread list goes back to the thread open before it', () => {
    seedThread({});
    useThreadHistoryStore.setState({ past: [{ threadId: 't1', projectId: 'p1' }], future: [] });
    useUIStore.setState({ leftPanelMode: 'threads', liveColumnsOpen: true });
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/grid' },
    );

    fireEvent.click(screen.getByTestId('tool-rail-threads'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
    expect(useUIStore.getState().liveColumnsOpen).toBe(false);
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
  });

  test('the inbox button opens the inbox and goes back to the thread open before it', () => {
    seedThread({});
    useThreadHistoryStore.setState({ past: [{ threadId: 't1', projectId: 'p1' }], future: [] });
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/projects/p1/threads/t1' },
    );

    fireEvent.click(screen.getByTestId('tool-rail-inbox'));
    expect(screen.getByTestId('location')).toHaveTextContent('/inbox');

    act(() => useUIStore.setState({ automationInboxOpen: true }));
    expect(screen.getByTestId('tool-rail-inbox')).toHaveAttribute('aria-pressed', 'true');
    // The inbox takes the sidebar's place: no sidebar view is lit.
    expect(screen.getByTestId('tool-rail-threads')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('tool-rail-inbox'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
  });

  test('with the inbox beside a thread, the inbox button brings the thread list back', () => {
    seedThread({});
    useUIStore.setState({ leftPanelMode: 'inbox' });
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/projects/p1/threads/t1' },
    );

    const inbox = screen.getByTestId('tool-rail-inbox');
    expect(inbox).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(inbox);
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
    // The thread stays open in the center.
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
  });

  test('choosing a sidebar view while the inbox is open leaves the inbox', () => {
    seedThread({});
    useThreadHistoryStore.setState({ past: [{ threadId: 't1', projectId: 'p1' }], future: [] });
    useUIStore.setState({ automationInboxOpen: true, leftPanelMode: 'threads' });
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/inbox' },
    );

    fireEvent.click(screen.getByTestId('tool-rail-threads'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
    expect(useUIStore.getState().leftPanelMode).toBe('threads');
  });

  for (const mode of ['factory', 'kanban'] as const) {
    test(`entering the ${mode} view shows it alone, with no thread in the center`, () => {
      seedThread({});
      useUIStore.setState({ leftPanelMode: 'threads', leftViewFillsWindow: false });
      renderWithProviders(
        <>
          <ToolRail />
          <LocationProbe />
        </>,
        { threadId: 't1', route: '/projects/p1/threads/t1' },
      );

      fireEvent.click(screen.getByTestId(`tool-rail-${mode}`));
      expect(useUIStore.getState().leftPanelMode).toBe(mode);
      expect(useUIStore.getState().leftViewFillsWindow).toBe(true);
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);

      // Pressing it again goes back to the thread list, which does not fill the window.
      fireEvent.click(screen.getByTestId(`tool-rail-${mode}`));
      expect(useUIStore.getState().leftPanelMode).toBe('threads');
      expect(useUIStore.getState().leftViewFillsWindow).toBe(false);
    });
  }
});

function LocationProbe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}
