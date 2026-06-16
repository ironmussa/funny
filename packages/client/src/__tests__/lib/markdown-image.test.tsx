import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { baseMarkdownComponents, remarkPlugins } from '@/lib/markdown-components';
import { __resetVisualizerRegistry } from '@/lib/visualizer-registry';
import { useMediaPreviewStore } from '@/stores/media-preview-store';
import { registerBuiltinVisualizers } from '@/visualizers/builtin';

const Img = baseMarkdownComponents.img;

afterEach(() => {
  cleanup();
  useMediaPreviewStore.getState().close();
  __resetVisualizerRegistry();
  vi.unstubAllGlobals();
});

describe('markdown img', () => {
  test('rewrites a local file path through /api/files/raw', () => {
    render(createElement(Img, { src: '/home/u/out.png', alt: 'shot' }));
    const img = screen.getByTestId('markdown-image') as HTMLImageElement;
    // jsdom resolves to an absolute URL; assert the pathname+query, not the origin.
    const url = new URL(img.src);
    expect(url.pathname).toBe('/api/files/raw');
    expect(url.searchParams.get('path')).toBe('/home/u/out.png');
    expect(img.alt).toBe('shot');
  });

  test('passes a web URL through untouched and renders it in the image card', () => {
    render(createElement(Img, { src: 'https://x.com/a.png', alt: 'remote' }));
    expect((screen.getByTestId('markdown-image') as HTMLImageElement).src).toBe(
      'https://x.com/a.png',
    );
    // External images also get the rich card; Expand opens the lightbox (zoom/pan)
    // with the URL passed through unchanged.
    fireEvent.click(screen.getByTestId('markdown-image-expand'));
    expect(useMediaPreviewStore.getState().filePath).toBe('https://x.com/a.png');
  });

  test('the Expand control opens the media lightbox with the absolute path', () => {
    render(createElement(Img, { src: '/abs/diagram.png', alt: 'd' }));
    fireEvent.click(screen.getByTestId('markdown-image-expand'));
    const state = useMediaPreviewStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.filePath).toBe('/abs/diagram.png');
  });

  test('a failed local image swaps the broken <img> for the media error widget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Access denied: path is outside the allowed directories.' }),
      } as Response),
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
    const video = screen.getByTestId('visualizer-video') as HTMLVideoElement;
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

  // Guards the real risk: rehypeSanitize must KEEP a protocol-less absolute
  // path so our img override can rewrite it. (data:/javascript: stay stripped.)
  test('survives the rehypeSanitize markdown pipeline for a local path', () => {
    render(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins,
          rehypePlugins: [rehypeSanitize],
          components: baseMarkdownComponents,
        },
        '![shot](/home/u/out.png)',
      ),
    );
    const img = screen.getByTestId('markdown-image') as HTMLImageElement;
    expect(new URL(img.src).searchParams.get('path')).toBe('/home/u/out.png');
  });
});
