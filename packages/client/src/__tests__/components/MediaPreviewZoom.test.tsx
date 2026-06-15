import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { MediaPreview } from '@/components/MediaPreview';

afterEach(cleanup);

describe('MediaPreview image zoom controls', () => {
  test('renders the zoom toolbar inline (no extra click needed)', () => {
    render(<MediaPreview src="/api/files/raw?path=%2Fa.png" name="a.png" kind="image" />);
    // Regression: the zoom bar must be present in the preview itself, not
    // hidden behind a nested lightbox.
    expect(screen.getByTestId('image-zoom-controls')).toBeInTheDocument();
    expect(screen.getByTestId('image-zoom-reset')).toHaveTextContent('100%');
  });

  test('zoom in / out / reset adjust the scale', () => {
    render(<MediaPreview src="/api/files/raw?path=%2Fa.png" name="a.png" kind="image" />);
    const reset = screen.getByTestId('image-zoom-reset');

    fireEvent.click(screen.getByTestId('image-zoom-in'));
    expect(reset).toHaveTextContent('140%');

    fireEvent.click(screen.getByTestId('image-zoom-reset'));
    expect(reset).toHaveTextContent('100%');

    // Cannot zoom below fit.
    expect(screen.getByTestId('image-zoom-out')).toBeDisabled();
  });

  test('panning while zoomed does not throw and moves the image', () => {
    const { container } = render(
      <MediaPreview src="/api/files/raw?path=%2Fa.png" name="a.png" kind="image" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;

    // Zoom in so pan is enabled.
    fireEvent.click(screen.getByTestId('image-zoom-in'));
    const before = img.style.transform;

    // Regression: pointerdown read `e.currentTarget` inside a setState updater,
    // where it is already null → "Cannot read properties of null
    // (reading 'setPointerCapture')". A drag must not throw.
    expect(() => {
      fireEvent.pointerDown(img, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(img, { pointerId: 1, clientX: 160, clientY: 140 });
      fireEvent.pointerUp(img, { pointerId: 1, clientX: 160, clientY: 140 });
    }).not.toThrow();

    expect(img.style.transform).not.toBe(before);
  });
});
