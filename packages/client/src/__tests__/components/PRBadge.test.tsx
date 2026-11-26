import { afterEach, describe, expect, test } from 'bun:test';

import { fireEvent, screen } from '@testing-library/react';

import { PRBadge } from '@/components/PRBadge';
import { githubRepoOfUrl, useGitHubItemViewerStore } from '@/stores/github-item-viewer-store';

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

  test.each(['OPEN', 'MERGED', 'CLOSED'] as const)(
    'shows the %s glyph, so a merged PR does not look like an open one',
    (state) => {
      renderWithProviders(<PRBadge prNumber={7} prState={state} data-testid="pr" />);

      expect(screen.getByTestId(`pr-icon-${state}`)).toBeInTheDocument();
    },
  );

  test('supports a 16px compact size for powerline rows', () => {
    renderWithProviders(<PRBadge prNumber={31} size="compact" data-testid="pr-badge-compact" />);

    expect(screen.getByTestId('pr-badge-compact')).toHaveClass('h-4');
  });

  test('supports inverse styling for dark surfaces', () => {
    renderWithProviders(<PRBadge prNumber={86} variant="inverse" data-testid="pr-badge-inverse" />);

    expect(screen.getByTestId('pr-badge-inverse')).toHaveClass('bg-background/20');
    expect(screen.getByTestId('pr-badge-inverse')).toHaveClass('text-background/70');
  });

  test.each([
    ['OPEN', 'text-git-icon-pushed'],
    ['MERGED', 'text-git-icon-merged'],
    ['CLOSED', 'text-status-error'],
  ] as const)(
    'plain variant drops the pill and matches the git stat chips for %s',
    (state, textClass) => {
      renderWithProviders(
        <PRBadge prNumber={9} prState={state} variant="plain" data-testid="pr" />,
      );

      const badge = screen.getByTestId('pr');
      expect(badge).toHaveClass(textClass);
      expect(badge).toHaveClass('text-xs');
      expect(badge).not.toHaveClass('border');
      expect(screen.getByTestId(`pr-icon-${state}`)).toHaveClass('icon-sm');
    },
  );

  test("a compact plain badge takes a small powerline's text and icon size", () => {
    renderWithProviders(
      <PRBadge prNumber={9} prState="MERGED" variant="plain" size="compact" data-testid="pr" />,
    );

    const badge = screen.getByTestId('pr');
    expect(badge).toHaveClass('text-2xs');
    expect(badge).not.toHaveClass('text-xs');
    expect(badge).not.toHaveClass('border');
    expect(screen.getByTestId('pr-icon-MERGED')).not.toHaveClass('icon-sm');
  });

  describe('with a project', () => {
    afterEach(() => useGitHubItemViewerStore.getState().close());

    const url = 'https://github.com/acme/app/pull/12';

    test("a click opens funny's PR view, not GitHub", () => {
      renderWithProviders(<PRBadge prNumber={12} prUrl={url} projectId="p-1" data-testid="pr" />);

      const badge = screen.getByTestId('pr');
      expect(badge.tagName).toBe('BUTTON');
      expect(badge).not.toHaveAttribute('href');
      fireEvent.click(badge);

      expect(useGitHubItemViewerStore.getState().target).toEqual({
        kind: 'pr',
        projectId: 'p-1',
        number: 12,
        url,
      });
    });

    test('the external link icon beside it goes to GitHub', () => {
      renderWithProviders(
        <PRBadge
          prNumber={12}
          prUrl={url}
          projectId="p-1"
          variant="plain"
          showExternalIcon={false}
          data-testid="pr"
        />,
      );

      const external = screen.getByTestId('pr-external');
      expect(external).toHaveAttribute('href', url);
      expect(external).toHaveAttribute('target', '_blank');
      fireEvent.click(external);
      expect(useGitHubItemViewerStore.getState().target).toBeNull();
    });

    test('without a project the chip stays the GitHub link', () => {
      renderWithProviders(<PRBadge prNumber={12} prUrl={url} data-testid="pr" />);

      expect(screen.getByTestId('pr')).toHaveAttribute('href', url);
      expect(screen.queryByTestId('pr-external')).toBeNull();
    });
  });
});

describe('githubRepoOfUrl', () => {
  test('reads owner/repo of a GitHub URL, case-insensitively', () => {
    expect(githubRepoOfUrl('https://github.com/Acme/App/pull/3')).toBe('acme/app');
    expect(githubRepoOfUrl('https://github.com/acme/app/issues/3#c')).toBe('acme/app');
    expect(githubRepoOfUrl('https://example.com/acme/app')).toBeNull();
    expect(githubRepoOfUrl(undefined)).toBeNull();
  });
});
