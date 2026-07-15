import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { EditFileCard } from '@/components/tool-cards/EditFileCard';
import { TooltipProvider } from '@/components/ui/tooltip';

const intersectionObserverState = vi.hoisted(() => ({
  callback: null as IntersectionObserverCallback | null,
  observe: vi.fn(),
  disconnect: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  readFile: vi.fn(() => Promise.resolve({ isErr: () => true })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/components/VirtualDiff', () => ({
  VirtualDiff: ({
    'data-testid': testId,
    unifiedDiff,
  }: {
    'data-testid'?: string;
    unifiedDiff?: string;
  }) => <div data-testid={testId ?? 'virtual-diff'} data-unified-diff={unifiedDiff ?? ''} />,
}));

vi.mock('@/lib/api', () => ({
  api: {
    getFileDiff: apiMocks.getFileDiff,
    readFile: apiMocks.readFile,
  },
}));

vi.mock('@/stores/thread-context', () => ({
  useThreadId: () => 'thread-1',
  useThreadProjectId: () => undefined,
  useThreadWorktreePath: () => undefined,
  useThreadSelector: () => undefined,
}));

vi.mock('@/stores/project-store', () => ({
  useProjectStore: (selector: (state: { projects: never[] }) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock('@/stores/settings-store', () => ({
  DIFF_ROW_HEIGHT_PX: { small: 18, default: 20, large: 23 },
  editorLabels: { cursor: 'Cursor' },
  useSettingsStore: Object.assign(
    (selector: (state: { defaultEditor: string; fontSize: string }) => unknown) =>
      selector({ defaultEditor: 'cursor', fontSize: 'default' }),
    { getState: () => ({ defaultEditor: 'cursor', useInternalEditor: false }) },
  ),
}));

describe('EditFileCard', () => {
  beforeEach(() => {
    intersectionObserverState.callback = null;
    intersectionObserverState.observe.mockClear();
    intersectionObserverState.disconnect.mockClear();
    apiMocks.getFileDiff.mockReset();

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly scrollMargin = '';
      readonly thresholds = [];

      constructor(callback: IntersectionObserverCallback) {
        intersectionObserverState.callback = callback;
      }

      observe = intersectionObserverState.observe;
      unobserve = vi.fn();
      disconnect = intersectionObserverState.disconnect;
      takeRecords = () => [];
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  test('keeps the inline diff slot height stable while lazy-mounting the diff', async () => {
    render(
      <TooltipProvider>
        <EditFileCard
          parsed={{
            file_path: '/repo/src/app.ts',
            old_string: 'const value = 1;\nconsole.log(value);',
            new_string: 'const value = 2;\nconsole.log(value);',
          }}
        />
      </TooltipProvider>,
    );

    const placeholder = screen.getByTestId('edit-file-inline-diff-placeholder');
    const slot = placeholder.parentElement as HTMLElement;
    const reservedHeight = slot.style.height;

    expect(reservedHeight).toMatch(/^\d+px$/);

    await act(async () => {
      intersectionObserverState.callback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    const diff = await screen.findByTestId('edit-file-inline-diff');
    expect(diff.parentElement).toBe(slot);
    expect(slot.style.height).toBe(reservedHeight);
    expect(screen.queryByTestId('edit-file-inline-diff-placeholder')).not.toBeInTheDocument();
  });

  test('mounts a visible diff when IntersectionObserver does not notify', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 24,
      width: 480,
      height: 64,
      top: 24,
      right: 480,
      bottom: 88,
      left: 0,
      toJSON: () => ({}),
    });

    render(
      <TooltipProvider>
        <EditFileCard
          parsed={{
            file_path: '/repo/src/app.ts',
            old_string: 'const value = 1;',
            new_string: 'const value = 2;',
          }}
        />
      </TooltipProvider>,
    );

    expect(await screen.findByTestId('edit-file-inline-diff')).toBeInTheDocument();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('renders Codex changes-map edit calls as diffs', async () => {
    render(
      <TooltipProvider>
        <EditFileCard
          parsed={{
            file_path: '/repo/src/app.ts',
            new_string: 'export const value = 1;\n',
            changes: {
              '/repo/src/app.ts': {
                type: 'add',
                content: 'export const value = 1;\n',
              },
              '/repo/src/config.ts': {
                type: 'update',
                unified_diff:
                  '@@ -1,1 +1,1 @@\n-export const port = 3000;\n+export const port = 5173;',
              },
            },
          }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText('/repo/src/app.ts +1')).toBeInTheDocument();
    const placeholder = screen.getByTestId('edit-file-inline-diff-placeholder');
    const slot = placeholder.parentElement;

    await act(async () => {
      intersectionObserverState.callback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    const diff = await screen.findByTestId('edit-file-inline-diff');
    expect(diff.parentElement).toBe(slot);
    expect(diff.getAttribute('data-unified-diff')).toContain('+export const value = 1;');
  });

  test('renders combined merge diffs from Codex changes maps', async () => {
    render(
      <TooltipProvider>
        <EditFileCard
          parsed={{
            changes: {
              '/repo/src/AssemblyManager.tsx': {
                type: 'update',
                unified_diff: [
                  'diff --cc src/AssemblyManager.tsx',
                  '@@@ -10,1 -10,1 +10,1 @@@',
                  ' -const before = true;',
                  ' +const after = true;',
                ].join('\n'),
              },
            },
          }}
        />
      </TooltipProvider>,
    );

    await act(async () => {
      intersectionObserverState.callback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    const diff = await screen.findByTestId('edit-file-inline-diff');
    expect(diff.getAttribute('data-unified-diff')).toContain('@@@ -10,1 -10,1 +10,1 @@@');
  });

  test('loads the diff for the SDK path-and-kind change format', async () => {
    apiMocks.getFileDiff.mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: {
        diff: '@@ -1,1 +1,1 @@\n-export const port = 3000;\n+export const port = 5173;',
      },
    });

    render(
      <TooltipProvider>
        <EditFileCard
          hideLabel
          parsed={{
            changes: [{ path: '/repo/src/config.ts', kind: 'update' }],
          }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText('/repo/src/config.ts')).toBeInTheDocument();
    expect(apiMocks.getFileDiff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('edit-file-inline-diff-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(apiMocks.getFileDiff).toHaveBeenCalledWith(
        'thread-1',
        '/repo/src/config.ts',
        false,
        undefined,
        'full',
      ),
    );

    await act(async () => {
      intersectionObserverState.callback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    const diff = await screen.findByTestId('edit-file-inline-diff');
    expect(diff.getAttribute('data-unified-diff')).toContain('+export const port = 5173;');
  });

  test('explains when a historical SDK change no longer has a Git diff', async () => {
    apiMocks.getFileDiff.mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: { diff: '' },
    });

    render(
      <TooltipProvider>
        <EditFileCard parsed={{ changes: [{ path: '/repo/src/config.ts', kind: 'update' }] }} />
      </TooltipProvider>,
    );

    const unavailable = await screen.findByTestId('edit-file-inline-diff-unavailable');
    expect(unavailable).toHaveTextContent('tools.diffUnavailableNoTracking');
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(apiMocks.getFileDiff).toHaveBeenCalledTimes(2));
  });

  test('does not leave a blank panel when a captured change has no diff hunk', async () => {
    apiMocks.getFileDiff.mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: { diff: 'diff --git a/src/config.ts b/src/config.ts\nBinary files differ' },
    });

    render(
      <TooltipProvider>
        <EditFileCard
          parsed={{
            changes: {
              '/repo/src/config.ts': {
                type: 'update',
                unified_diff: 'diff --git a/src/config.ts b/src/config.ts\nBinary files differ',
              },
            },
          }}
        />
      </TooltipProvider>,
    );

    expect(await screen.findByTestId('edit-file-inline-diff-unavailable')).toBeInTheDocument();
    expect(apiMocks.getFileDiff).toHaveBeenCalledTimes(1);
  });
});
