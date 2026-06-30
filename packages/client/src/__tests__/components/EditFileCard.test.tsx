import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { EditFileCard } from '@/components/tool-cards/EditFileCard';
import { TooltipProvider } from '@/components/ui/tooltip';

const intersectionObserverState = vi.hoisted(() => ({
  callback: null as IntersectionObserverCallback | null,
  observe: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/components/VirtualDiff', () => ({
  VirtualDiff: ({ 'data-testid': testId }: { 'data-testid'?: string }) => (
    <div data-testid={testId ?? 'virtual-diff'} />
  ),
}));

vi.mock('@/lib/api', () => ({
  api: {
    readFile: vi.fn(() => Promise.resolve({ isErr: () => true })),
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
  useSettingsStore: (selector: (state: { defaultEditor: string; fontSize: string }) => unknown) =>
    selector({ defaultEditor: 'cursor', fontSize: 'default' }),
}));

describe('EditFileCard', () => {
  beforeEach(() => {
    intersectionObserverState.callback = null;
    intersectionObserverState.observe.mockClear();
    intersectionObserverState.disconnect.mockClear();

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
});
