import { describe, expect, test, vi } from 'bun:test';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { cloneElement } from 'react';

import { PowerlineBar } from '@/components/ui/powerline-bar';

describe.each(['arrow', 'chips', 'plain'] as const)('PowerlineBar %s', (variant) => {
  test('renders a real repository link with its URL and no copy action', () => {
    render(
      <PowerlineBar
        variant={variant}
        segments={[
          {
            key: 'repo',
            label: 'acme/repo',
            color: '#7CB9E8',
            href: 'https://github.com/acme/repo',
            copyValue: 'do not copy',
          },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: 'acme/repo' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/repo');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).not.toHaveAttribute('role', 'button');
  });

  test('allows a picker to use the styled segment as a native button', () => {
    const open = vi.fn();
    const triggerProps = { onClick: open };
    render(
      <PowerlineBar
        variant={variant}
        segments={[
          {
            key: 'branch',
            label: 'main',
            color: '#7CB9E8',
            renderTrigger: (trigger) => cloneElement(trigger, triggerProps),
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('PowerlineBar theme variant', () => {
  const segments = [
    { key: 'project', label: 'funny', color: '#7CB9E8' },
    { key: 'branch', label: 'master', color: '#5a8fb8' },
  ];

  test('follows a theme switch without remounting', async () => {
    const html = document.documentElement;
    render(<PowerlineBar segments={segments} />);
    // The default (arrow) shape has no slash separator.
    expect(screen.queryByText('/')).not.toBeInTheDocument();

    await act(async () => {
      html.style.setProperty('--powerline-variant', 'plain');
      html.classList.add('theme-minimal');
      // MutationObserver callbacks run as microtasks.
      await Promise.resolve();
    });
    expect(screen.getByText('/')).toBeInTheDocument();

    await act(async () => {
      html.style.removeProperty('--powerline-variant');
      html.classList.remove('theme-minimal');
      await Promise.resolve();
    });
    expect(screen.queryByText('/')).not.toBeInTheDocument();
  });
});
