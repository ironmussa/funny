import { fireEvent, render, screen } from '@testing-library/react';
import { cloneElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

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
    render(
      <PowerlineBar
        variant={variant}
        segments={[
          {
            key: 'branch',
            label: 'main',
            color: '#7CB9E8',
            renderTrigger: (trigger) => cloneElement(trigger, { onClick: open } as object),
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'main' }));
    expect(open).toHaveBeenCalledOnce();
  });
});
