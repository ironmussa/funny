import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

interface ProviderOptions {
  route?: string;
  /** When provided, wraps with a ThreadProvider so context-aware hooks work in tests. */
  threadId?: string | null;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: ProviderOptions & Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  const { route, threadId, ...renderOptions } = options ?? {};

  // Default to the store's active thread id so tests that seed activeThread via
  // setState don't need to also thread the id through the provider.
  const resolvedThreadId =
    threadId !== undefined ? threadId : (useThreadStore.getState().activeThread?.id ?? null);

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route ?? '/']}>
        <TooltipProvider>
          <ThreadProvider threadId={resolvedThreadId} source="active">
            {children}
          </ThreadProvider>
        </TooltipProvider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
