import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

import { MarkdownImageCard } from '@/components/MarkdownImageCard';
import { useMediaPreviewStore } from '@/stores/media-preview-store';

afterEach(() => {
  cleanup();
  useMediaPreviewStore.getState().close();
});

const noErrorFallback = () => false;

function renderCard(src: string, originalSrc = src) {
  return render(
    createElement(MarkdownImageCard, { src, originalSrc, onMediaError: noErrorFallback }),
  );
}

describe('MarkdownImageCard', () => {
  test('shows a filename header derived from a local path', () => {
    renderCard('/api/files/raw?path=%2Fa%2Fshot.png', '/a/shot.png');
    expect(screen.getByTestId('markdown-image-name').textContent).toBe('shot.png');
  });

  test('derives the filename from a web URL, dropping the query string', () => {
    renderCard('https://x.test/a/b/pic.webp?v=2');
    expect(screen.getByTestId('markdown-image-name').textContent).toBe('pic.webp');
  });

  test('zoom in raises the percentage and 1:1 resets it to fit', () => {
    renderCard('https://x.test/y.png');
    expect(screen.getByTestId('markdown-image-zoom').textContent).toBe('100%');
    fireEvent.click(screen.getByTestId('markdown-image-zoom-in'));
    expect(screen.getByTestId('markdown-image-zoom').textContent).toBe('120%');
    fireEvent.click(screen.getByTestId('markdown-image-zoom-reset'));
    expect(screen.getByTestId('markdown-image-zoom').textContent).toBe('100%');
  });

  test('Expand opens the shared lightbox with the original src', () => {
    renderCard('https://x.test/y.png');
    fireEvent.click(screen.getByTestId('markdown-image-expand'));
    const state = useMediaPreviewStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.filePath).toBe('https://x.test/y.png');
  });
});
