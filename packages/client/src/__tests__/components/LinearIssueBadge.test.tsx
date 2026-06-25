import { screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { LinearIssueBadge } from '@/components/LinearIssueBadge';

import { renderWithProviders } from '../helpers/render';

describe('LinearIssueBadge', () => {
  test('renders a Linear issue link with the brand icon, issue key, and external icon affordance', () => {
    renderWithProviders(
      <LinearIssueBadge
        issueKey="GOL-728"
        issueUrl="https://linear.app/goliiive-v3/issue/GOL-728/core-catalogo-publico"
        data-testid="linear-issue-badge"
      />,
    );

    const badge = screen.getByTestId('linear-issue-badge');
    expect(badge).toHaveAccessibleName('Linear GOL-728');
    expect(badge).toHaveTextContent('GOL-728');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge).toHaveAttribute(
      'href',
      'https://linear.app/goliiive-v3/issue/GOL-728/core-catalogo-publico',
    );
  });

  test('supports inverse contrast for user message cards', () => {
    renderWithProviders(
      <LinearIssueBadge
        issueKey="GOL-760"
        issueUrl="https://linear.app/goliiive-v3/issue/GOL-760/example"
        variant="inverse"
        data-testid="linear-issue-badge"
      />,
    );

    const badge = screen.getByTestId('linear-issue-badge');
    expect(badge).toHaveClass('bg-background/20');
    expect(badge).toHaveClass('text-background/70');
  });
});
