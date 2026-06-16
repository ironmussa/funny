import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

import { MediaPreviewDialog } from '@/components/MediaPreviewDialog';

afterEach(cleanup);

function renderDialog(filePath: string) {
  return render(
    createElement(MediaPreviewDialog, { open: true, onOpenChange: () => {}, filePath }),
  );
}

function previewImg() {
  return screen.getByTestId('media-preview-image').querySelector('img') as HTMLImageElement;
}

describe('MediaPreviewDialog src resolution', () => {
  test('routes a local image path through /api/files/raw', () => {
    renderDialog('/abs/shot.png');
    const url = new URL(previewImg().src);
    expect(url.pathname).toBe('/api/files/raw');
    expect(url.searchParams.get('path')).toBe('/abs/shot.png');
  });

  test('passes an external web image URL through untouched (zoom/pan on a remote image)', () => {
    renderDialog('https://x.com/a.webp');
    expect(previewImg().src).toBe('https://x.com/a.webp');
  });
});

describe('MediaPreviewDialog image toolbar (header, Mermaid-style)', () => {
  test('renders the zoom toolbar in the header; zoom in raises % and 1:1 resets', () => {
    renderDialog('/abs/shot.png');
    expect(screen.getByTestId('media-preview-zoom').textContent).toBe('100%');
    fireEvent.click(screen.getByTestId('media-preview-zoom-in'));
    expect(screen.getByTestId('media-preview-zoom').textContent).toBe('120%');
    fireEvent.click(screen.getByTestId('media-preview-zoom-reset'));
    expect(screen.getByTestId('media-preview-zoom').textContent).toBe('100%');
  });

  test('a non-image (video) uses the generic preview, not the image toolbar', () => {
    renderDialog('/abs/clip.mp4');
    expect(screen.getByTestId('media-preview-video')).toBeTruthy();
    expect(screen.queryByTestId('media-preview-zoom')).toBeNull();
  });
});
