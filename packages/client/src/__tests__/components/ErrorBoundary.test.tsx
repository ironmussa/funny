import { fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/components/ErrorBoundary';

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    'Failed to fetch dynamically imported module: http://localhost:5173/ChangesPanel.tsx',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Loading chunk 123 failed.',
    'Unable to preload CSS for /assets/panel.css',
  ])('contains a rejected lazy import and offers a working reload: %s', async (message) => {
    const load = vi.fn(() => Promise.reject(new TypeError(message)));
    const Panel = lazy(load);
    render(
      <ErrorBoundary area="app">
        <div>Thread stays visible</div>
        <ErrorBoundary area="review-changes">
          <Suspense fallback={<div>Loading</div>}>
            <Panel />
          </Suspense>
        </ErrorBoundary>
      </ErrorBoundary>,
    );

    const reloadButton = await screen.findByRole('button', { name: 'Reload page' });
    expect(screen.getByText('Thread stays visible')).toBeInTheDocument();
    expect(screen.getByTestId('error-boundary-review-changes')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-app')).not.toBeInTheDocument();

    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('can retry an ordinary render failure without reloading', () => {
    let broken = true;
    function Panel() {
      if (broken) throw new Error('Render failed');
      return <div>Recovered panel</div>;
    }
    render(
      <ErrorBoundary area="panel">
        <Panel />
      </ErrorBoundary>,
    );

    expect(screen.queryByRole('button', { name: 'Reload page' })).not.toBeInTheDocument();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered panel')).toBeInTheDocument();
  });

  it('shows a fallback for an otherwise uncaught app failure', () => {
    function App(): never {
      throw new Error('App failed');
    }
    render(
      <ErrorBoundary area="app">
        <App />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-app')).toBeInTheDocument();
  });
});
