import { screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { PRBadge } from '@/components/PRBadge';

import { renderWithProviders } from '../helpers/render';

describe('PRBadge', () => {
  test.each([
    ['OPEN', 'bg-emerald-50', 'text-emerald-700'],
    ['MERGED', 'bg-violet-50', 'text-violet-700'],
    ['CLOSED', 'bg-rose-50', 'text-rose-700'],
  ] as const)('uses a pastel state color for %s pull requests', (state, bgClass, textClass) => {
    renderWithProviders(
      <PRBadge prNumber={42} prState={state} data-testid={`pr-badge-${state}`} />,
    );

    expect(screen.getByTestId(`pr-badge-${state}`)).toHaveClass(bgClass);
    expect(screen.getByTestId(`pr-badge-${state}`)).toHaveClass(textClass);
  });

  test('supports a 15px compact size for powerline rows', () => {
    renderWithProviders(<PRBadge prNumber={31} size="compact" data-testid="pr-badge-compact" />);

    expect(screen.getByTestId('pr-badge-compact')).toHaveClass('h-[15px]');
  });
});
