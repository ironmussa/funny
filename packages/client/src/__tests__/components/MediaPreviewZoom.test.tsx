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
});
