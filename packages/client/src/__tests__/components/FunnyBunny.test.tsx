import { describe, expect, test } from 'bun:test';

import { render } from '@testing-library/react';

import { FunnyBunny } from '@/components/FunnyBunny';

describe('FunnyBunny', () => {
  test('renders at the requested size and exposes its state', () => {
    const { getByTestId } = render(<FunnyBunny state="working" size={48} />);
    const svg = getByTestId('funny-bunny');

    expect(svg.getAttribute('width')).toBe('48');
    expect(svg.getAttribute('data-state')).toBe('working');
    expect(svg.getAttribute('aria-label')).toBe('funny is working');
  });

  test('each instance cuts its face with its own mask', () => {
    const { getAllByTestId } = render(
      <>
        <FunnyBunny />
        <FunnyBunny />
      </>,
    );
    const ids = getAllByTestId('funny-bunny').map((svg) => {
      const id = svg.querySelector('mask')?.id ?? '';
      // The face must reference this instance's mask, and the id must be a valid url() target.
      expect(svg.querySelector(`[mask="url(#${id})"]`)).not.toBeNull();
      expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
      return id;
    });

    expect(new Set(ids).size).toBe(2);
  });
});
