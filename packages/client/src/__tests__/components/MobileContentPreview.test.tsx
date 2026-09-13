import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  MobileContentPreview,
  ToolContentArea,
} from '@/components/tool-cards/MobileContentPreview';

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => viewport.mobile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  viewport.mobile = true;
});

describe('mobile thread content', () => {
  test('keeps the preview mounted and inert while opening live content in a separate viewer', () => {
    const { container, rerender } = render(
      <ToolContentArea>
        <pre>First output</pre>
      </ToolContentArea>,
    );
    const preview = screen.getByTestId('mobile-content-preview');
    expect(preview.querySelector('[inert]')).toBeTruthy();
    expect(container.querySelector('[data-radix-scroll-area-viewport]')).toBeNull();
    const trigger = screen.getByRole('button', { name: 'tools.viewFullContent' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('First output')).toBeInTheDocument();
    expect(preview).toBeInTheDocument();
    rerender(
      <ToolContentArea>
        <pre>Updated output</pre>
      </ToolContentArea>,
    );
    expect(within(dialog).getByText('Updated output')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'tools.closeViewer' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-content-preview')).toBe(preview);
  });

  test('uses the specialized diff viewer when provided', () => {
    const onExpand = vi.fn();
    render(
      <MobileContentPreview label="View full diff" onExpand={onExpand}>
        <pre>Diff</pre>
      </MobileContentPreview>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View full diff' }));
    expect(onExpand).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('retains desktop scrolling and has no mobile controls', () => {
    viewport.mobile = false;
    const { container } = render(
      <ToolContentArea viewportProps={{ className: 'max-h-[50vh]' }}>
        <pre>Output</pre>
      </ToolContentArea>,
    );
    expect(container.querySelector('[data-radix-scroll-area-viewport]')).toHaveClass(
      'max-h-[50vh]',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
