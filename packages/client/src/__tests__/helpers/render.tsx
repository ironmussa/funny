import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';

interface ProviderOptions {
  route?: string;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: ProviderOptions & Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  const { route = '/', ...renderOptions } = options ?? {};

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <TooltipProvider>{children}</TooltipProvider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
