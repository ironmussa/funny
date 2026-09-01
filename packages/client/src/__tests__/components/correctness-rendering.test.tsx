import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectUrlPatterns } from '@/components/general-settings-project/project-section-rows';
import { AttachmentChip } from '@/components/ui/chip';

vi.mock('@/components/ui/tooltip-icon-button', () => ({
  TooltipIconButton: ({
    children,
    onClick,
    tooltip,
  }: {
    children: ReactNode;
    onClick?: () => void;
    tooltip: string;
  }) => (
    <button type="button" aria-label={tooltip} onClick={onClick}>
      {children}
    </button>
  ),
}));

describe('correctness rendering regressions', () => {
  it('preserves a URL input DOM node when an earlier row is removed', () => {
    const onSave = vi.fn();
    render(
      <ProjectUrlPatterns
        projectId="project-1"
        currentUrls={['https://one.test', 'https://two.test']}
        onSave={onSave}
      />,
    );

    const originalInputs = screen.getAllByPlaceholderText('https://example.com');
    const secondInput = originalInputs[1];
    secondInput.focus();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    const remainingInput = screen.getByPlaceholderText('https://example.com');
    expect(remainingInput).toBe(secondInput);
    expect(remainingInput).toHaveFocus();
    expect(onSave).toHaveBeenCalledWith('project-1', { urls: ['https://two.test'] });
  });

  it('does not render a stray zero for a numeric runtime size', () => {
    const { container } = render(<AttachmentChip name="empty.txt" size={0 as unknown as string} />);

    expect(container).toHaveTextContent('empty.txt');
    expect(container).not.toHaveTextContent('empty.txt0');
  });
});
