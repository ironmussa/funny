import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { MediaLoadError } from '@/components/MediaLoadError';

function mockFetchOnce(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue(res as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MediaLoadError', () => {
  test('shows the static reason immediately when no probeUrl is given', () => {
    render(createElement(MediaLoadError, { reason: 'Failed to load preview.' }));
    expect(screen.getByTestId('media-load-error')).toBeTruthy();
    expect(screen.getByText('Failed to load preview.')).toBeTruthy();
  });

  test('probes the URL and surfaces a 403 deny reason from the runner body', async () => {
    mockFetchOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Access denied: path is outside allowed directories' }),
    });
    render(createElement(MediaLoadError, { probeUrl: '/api/files/raw?path=%2Fx.png' }));
    await waitFor(() =>
      expect(screen.getByText('Access denied: path is outside allowed directories')).toBeTruthy(),
    );
  });

  test('falls back to a status default for a 404 with no JSON body', async () => {
    mockFetchOnce({
      ok: false,
      status: 404,
      json: async () => {
        throw new Error('not json');
      },
    });
    render(createElement(MediaLoadError, { probeUrl: '/api/files/raw?path=%2Fmissing.png' }));
    await waitFor(() => expect(screen.getByText('File not found.')).toBeTruthy());
  });

  test('reports an unreachable runner when the probe itself throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(MediaLoadError, { probeUrl: '/api/files/raw?path=%2Fx.png' }));
    await waitFor(() =>
      expect(screen.getByText('Could not reach the runner to load this file.')).toBeTruthy(),
    );
  });
});
