import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadProvider } from '@/stores/thread-context';

interface ProviderOptions {
  route?: string;
  /** When provided, wraps with a ThreadProvider so context-aware hooks work in tests. */
  threadId?: string | null;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: ProviderOptions & Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  const { route = '/', threadId = null, ...renderOptions } = options ?? {};

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <TooltipProvider>
          <ThreadProvider threadId={threadId} source="active">
            {children}
          </ThreadProvider>
        </TooltipProvider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
