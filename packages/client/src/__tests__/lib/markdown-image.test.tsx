import { afterEach, describe, expect, test, vi } from 'bun:test';

import { stubGlobal, unstubAllGlobals } from '@funny/test-kit';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';

import { baseMarkdownComponents } from '@/lib/markdown-components';
import { renderMarkdownToSafeHtml } from '@/lib/satteri-markdown';
import { resetVisualizerRegistry } from '@/lib/visualizer-registry';
import { useMediaPreviewStore } from '@/stores/media-preview-store';
import { registerBuiltinVisualizers } from '@/visualizers/builtin';

import { getByTestIdOfType } from '../helpers/builders-lib';

const Img = baseMarkdownComponents.img;

afterEach(() => {
  cleanup();
  useMediaPreviewStore.getState().close();
  resetVisualizerRegistry();
  unstubAllGlobals();
});

describe('markdown img', () => {
  test('an <img> with an explicit size stays inline at that size, not in the image card', () => {
    // CodeRabbit's severity icons: <img src="…/amber-16.svg" width="16" height="16">.
    render(createElement(Img, { src: 'https://x.com/amber-16.svg', width: '16', height: '16' }));
    const img = getByTestIdOfType('markdown-inline-image', HTMLImageElement);
    expect(img.getAttribute('width')).toBe('16');
    expect(img.getAttribute('height')).toBe('16');
    expect(screen.queryByTestId('markdown-image-expand')).toBeNull();
  });

  test('rewrites a local file path through /api/files/raw', () => {
    render(createElement(Img, { src: '/home/u/out.png', alt: 'shot' }));
    const img = getByTestIdOfType('markdown-image', HTMLImageElement);
    // jsdom resolves to an absolute URL; assert the pathname+query, not the origin.
    const url = new URL(img.src);
    expect(url.pathname).toBe('/api/files/raw');
    expect(url.searchParams.get('path')).toBe('/home/u/out.png');
    expect(img.alt).toBe('shot');
  });

  test('passes a web URL through untouched and renders it in the image card', () => {
    render(createElement(Img, { src: 'https://x.com/a.png', alt: 'remote' }));
    expect(getByTestIdOfType('markdown-image', HTMLImageElement).src).toBe('https://x.com/a.png');
    // External images also get the rich card; Expand opens the same thread
    // lightbox used by prompt image attachments.
    fireEvent.click(screen.getByTestId('markdown-image-expand'));
    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
    expect(getByTestIdOfType('lightbox-image', HTMLImageElement).src).toBe('https://x.com/a.png');
    expect(useMediaPreviewStore.getState().isOpen).toBe(false);
  });

  test('the Expand control opens the thread lightbox with the resolved absolute path', () => {
    render(createElement(Img, { src: '/abs/diagram.png', alt: 'd' }));
    fireEvent.click(screen.getByTestId('markdown-image-expand'));
    expect(screen.getByTestId('image-lightbox')).toBeInTheDocument();
    const url = new URL(getByTestIdOfType('lightbox-image', HTMLImageElement).src);
    expect(url.pathname).toBe('/api/files/raw');
    expect(url.searchParams.get('path')).toBe('/abs/diagram.png');
    expect(useMediaPreviewStore.getState().isOpen).toBe(false);
  });

  test('a failed local image swaps the broken <img> for the media error widget', async () => {
    stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ error: 'Access denied: path is outside the allowed directories.' }),
              { status: 403 },
            ),
        ),
    );
    render(createElement(Img, { src: '/home/u/out.png', alt: 'shot' }));
    fireEvent.error(screen.getByTestId('markdown-image'));
    // The broken <img> is gone, replaced by the shared error widget…
    expect(screen.queryByTestId('markdown-image')).toBeNull();
    expect(screen.getByTestId('media-load-error')).toBeTruthy();
    // …which probes the raw URL and names the real reason.
    await waitFor(() =>
      expect(
        screen.getByText('Access denied: path is outside the allowed directories.'),
      ).toBeTruthy(),
    );
  });

  test('renders nothing when src is missing', () => {
    const { container } = render(createElement(Img, { src: undefined, alt: 'x' }));
    expect(container.querySelector('img')).toBeNull();
  });

  test('a local video path renders the binary video visualizer, not an <img>', () => {
    registerBuiltinVisualizers();
    const { container } = render(createElement(Img, { src: '/abs/clip.mp4', alt: 'demo' }));
    expect(screen.getByTestId('markdown-binary-visualizer')).toBeTruthy();
    const video = getByTestIdOfType('visualizer-video', HTMLVideoElement);
    expect(new URL(video.src).searchParams.get('path')).toBe('/abs/clip.mp4');
    expect(container.querySelector('img')).toBeNull();
  });

  test('a local image keeps the native <img>+lightbox path even with the image visualizer registered', () => {
    // The image visualizer is binary, but markdown images must NOT defer to it —
    // a native <img> renders them and this sink adds the click-to-zoom lightbox.
    registerBuiltinVisualizers();
    render(createElement(Img, { src: '/abs/diagram.png', alt: 'd' }));
    expect(screen.queryByTestId('markdown-binary-visualizer')).toBeNull();
    expect(screen.queryByTestId('visualizer-image')).toBeNull();
    expect(screen.getByTestId('markdown-image')).toBeTruthy();
    expect(screen.getByTestId('markdown-image-card')).toBeTruthy();
  });

  test('a web video URL is left as a plain <img> (not routed through the visualizer)', () => {
    registerBuiltinVisualizers();
    render(createElement(Img, { src: 'https://x.com/clip.mp4', alt: 'remote' }));
    // External URLs are never treated as local files, so no binary dispatch.
    expect(screen.queryByTestId('markdown-binary-visualizer')).toBeNull();
    expect(screen.getByTestId('markdown-image')).toBeTruthy();
  });

  test('survives the Sätteri sanitizer for a local path', async () => {
    const document = new DOMParser().parseFromString(
      await renderMarkdownToSafeHtml('![shot](/home/u/out.png)'),
      'text/html',
    );
    const source = document.querySelector('img')?.getAttribute('src');
    render(createElement(Img, { src: source ?? undefined, alt: 'shot' }));
    const img = getByTestIdOfType('markdown-image', HTMLImageElement);
    expect(new URL(img.src).searchParams.get('path')).toBe('/home/u/out.png');
  });
});
