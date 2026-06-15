import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { afterEach, describe, expect, test } from 'vitest';

import { baseMarkdownComponents, remarkPlugins } from '@/lib/markdown-components';
import { __resetVisualizerRegistry } from '@/lib/visualizer-registry';
import { useMediaPreviewStore } from '@/stores/media-preview-store';
import { registerBuiltinVisualizers } from '@/visualizers/builtin';

const Img = baseMarkdownComponents.img;

afterEach(() => {
  cleanup();
  useMediaPreviewStore.getState().close();
  __resetVisualizerRegistry();
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

  test('passes a web URL through untouched and does not wrap it in a button', () => {
    render(createElement(Img, { src: 'https://x.com/a.png', alt: 'remote' }));
    expect((screen.getByTestId('markdown-image') as HTMLImageElement).src).toBe(
      'https://x.com/a.png',
    );
    expect(screen.queryByTestId('markdown-image-button')).toBeNull();
  });

  test('clicking a local image opens the media lightbox with the absolute path', () => {
    render(createElement(Img, { src: '/abs/diagram.png', alt: 'd' }));
    fireEvent.click(screen.getByTestId('markdown-image-button'));
    const state = useMediaPreviewStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.filePath).toBe('/abs/diagram.png');
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
