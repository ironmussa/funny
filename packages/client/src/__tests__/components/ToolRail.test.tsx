/**
 * The tool rail (openspec `tool-panels`): one icon per available panel from
 * the registry, which opens, switches and closes the right panel, plus the
 * browser toggle, which scratch threads have too.
 */

import { beforeEach, describe, expect, test, mock } from 'bun:test';

import type { Thread } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router-dom';

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

  for (const view of ['factory', 'kanban'] as const) {
    test(`with the ${view} view beside a thread, its button brings the thread list back`, () => {
      seedThread({});
      renderWithProviders(
        <>
          <ToolRail />
          <LocationProbe />
        </>,
        { threadId: 't1', route: `/projects/p1/threads/t1?left=${view}&panel=files` },
      );
      const button = screen.getByTestId(`tool-rail-${view}`);
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('tool-rail-threads')).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(button);
      // The thread stays open; only the left view leaves the URL.
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/projects/p1/threads/t1?panel=files',
      );
      expect(screen.getByTestId('tool-rail-threads')).toHaveAttribute('aria-pressed', 'true');
    });
  }

  test('the threads button brings the thread list back from another view', () => {
    seedThread({});
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/projects/p1/threads/t1?left=factory' },
    );
    const threads = screen.getByTestId('tool-rail-threads');
    expect(threads).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(threads);
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
    expect(threads).toHaveAttribute('aria-pressed', 'true');
    // Pressing it again keeps the thread list: it is the sidebar's home view.
    fireEvent.click(threads);
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
  });

  // Regression: the view used to be a stored mode, so going back from
  // `/factory` to a thread left the queue open beside it.
  test('a thread URL with no left view shows the thread list, whatever was open before', () => {
    seedThread({});
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
        <BackButton />
      </>,
      { threadId: 't1', route: '/projects/p1/threads/t1' },
    );
    fireEvent.click(screen.getByTestId('tool-rail-factory'));
    expect(screen.getByTestId('location')).toHaveTextContent('/factory');
    expect(screen.getByTestId('tool-rail-factory')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('go-back'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
    expect(screen.getByTestId('tool-rail-factory')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('tool-rail-threads')).toHaveAttribute('aria-pressed', 'true');
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
    useUIStore.setState({ liveColumnsOpen: true });
    renderWithProviders(<ToolRail />, { threadId: 't1' });
    expect(screen.getByTestId('tool-rail-grid')).toHaveAttribute('aria-pressed', 'true');
    for (const id of ['threads', 'kanban', 'factory']) {
      expect(screen.getByTestId(`tool-rail-${id}`)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  test('opening the grid sets its flag in the same click as its URL', () => {
    seedThread({});
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/projects/p1/threads/t1?left=factory' },
    );

    fireEvent.click(screen.getByTestId('tool-rail-grid'));
    expect(screen.getByTestId('location')).toHaveTextContent('/grid');
    // No render where the URL is the grid's and the flag is still closed.
    expect(useUIStore.getState().liveColumnsOpen).toBe(true);
  });

  test('pressing the grid while it is shown does nothing', () => {
    seedThread({});
    useUIStore.setState({ liveColumnsOpen: true });
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
    useUIStore.setState({ liveColumnsOpen: true });
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

    expect(screen.getByTestId('tool-rail-inbox')).toHaveAttribute('aria-pressed', 'true');
    // The inbox takes the sidebar's place: no sidebar view is lit.
    expect(screen.getByTestId('tool-rail-threads')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('tool-rail-inbox'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
  });

  test('with the inbox beside a thread, the inbox button brings the thread list back', () => {
    seedThread({});
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/projects/p1/threads/t1?left=inbox' },
    );

    const inbox = screen.getByTestId('tool-rail-inbox');
    expect(inbox).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(inbox);
    expect(inbox).toHaveAttribute('aria-pressed', 'false');
    // The thread stays open in the center.
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
  });

  test('choosing a sidebar view while the inbox is open leaves the inbox', () => {
    seedThread({});
    useThreadHistoryStore.setState({ past: [{ threadId: 't1', projectId: 'p1' }], future: [] });
    useUIStore.setState({ automationInboxOpen: true });
    renderWithProviders(
      <>
        <ToolRail />
        <LocationProbe />
      </>,
      { threadId: 't1', route: '/inbox' },
    );

    fireEvent.click(screen.getByTestId('tool-rail-threads'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
  });

  for (const mode of ['factory', 'kanban'] as const) {
    test(`entering the ${mode} view shows it alone, on its own URL`, () => {
      seedThread({});
      useThreadHistoryStore.setState({ past: [{ threadId: 't1', projectId: 'p1' }], future: [] });
      renderWithProviders(
        <>
          <ToolRail />
          <LocationProbe />
        </>,
        { threadId: 't1', route: '/projects/p1/threads/t1' },
      );

      fireEvent.click(screen.getByTestId(`tool-rail-${mode}`));
      // The view has its own URL, so a reload or a shared link opens it again.
      expect(screen.getByTestId('location')).toHaveTextContent(`/${mode}`);
      expect(screen.getByTestId(`tool-rail-${mode}`)).toHaveAttribute('aria-pressed', 'true');

      // Pressing it again goes back to the thread that was open before.
      fireEvent.click(screen.getByTestId(`tool-rail-${mode}`));
      expect(screen.getByTestId('location')).toHaveTextContent('/projects/p1/threads/t1');
    });
  }
});

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go-back" onClick={() => navigate(-1)}>
      back
    </button>
  );
}
