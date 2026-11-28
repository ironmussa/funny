import { afterEach, describe, expect, test } from 'bun:test';

import { cleanup, render, screen } from '@testing-library/react';
import { lazy } from 'react';

import { BrowserPanelSlot } from '@/components/browser-panel/BrowserPanelSlot';

afterEach(cleanup);

describe('BrowserPanelSlot', () => {
  test('shows a loading state while the panel chunk loads, not an empty panel', () => {
    const Pending = lazy(() => new Promise<{ default: () => null }>(() => {}));
    render(
      <BrowserPanelSlot>
        <Pending />
      </BrowserPanelSlot>,
    );
    expect(screen.getByTestId('browser-panel-loading')).toBeTruthy();
  });

  test('offers a reload when the panel chunk fails to download', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const Failing = lazy(() =>
        Promise.reject(new TypeError('Failed to fetch dynamically imported module: /x.js')),
      );
      render(
        <BrowserPanelSlot>
          <Failing />
        </BrowserPanelSlot>,
      );
      expect(await screen.findByTestId('error-boundary-browser-panel')).toBeTruthy();
      expect(screen.getByTestId('error-boundary-retry-browser-panel').textContent).toBe(
        'Reload page',
      );
    } finally {
      console.error = originalError;
    }
  });

  test('renders the panel once it loads', async () => {
    const Loaded = lazy(() =>
      Promise.resolve({ default: () => <div data-testid="browser-panel">panel</div> }),
    );
    render(
      <BrowserPanelSlot>
        <Loaded />
      </BrowserPanelSlot>,
    );
    expect(await screen.findByTestId('browser-panel')).toBeTruthy();
  });
});
