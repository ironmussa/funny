import { describe, expect, test } from 'vitest';

import { DiffStats } from '@/components/DiffStats';

import { renderWithProviders } from '../helpers/render';

describe('DiffStats', () => {
  test('uses a 15px chip for xs diff stats', () => {
    const { container } = renderWithProviders(
      <DiffStats linesAdded={21} linesDeleted={7} dirtyFileCount={4} size="xs" />,
    );

    expect(container.firstElementChild).toHaveClass('h-[15px]', 'leading-[15px]');
  });

  test('uses the same file icon size as compact branch chips for xs diff stats', () => {
    const { container } = renderWithProviders(
      <DiffStats linesAdded={21} linesDeleted={7} dirtyFileCount={4} size="xs" />,
    );

    const fileIcon = container.querySelector('svg');
    expect(fileIcon).toHaveAttribute('width', '10');
    expect(fileIcon).toHaveAttribute('height', '10');
  });
});
