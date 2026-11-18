import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { AutoResumeMarker } from '@/components/thread/AutoResumeMarker';
import { TooltipProvider } from '@/components/ui/tooltip';

describe('AutoResumeMarker', () => {
  test('shows a divider with the resume time instead of the prompt', () => {
    render(
      <TooltipProvider>
        <AutoResumeMarker data-testid="auto-resume-m1" timestamp="2026-11-17T22:07:00.000Z" />
      </TooltipProvider>,
    );
    const marker = screen.getByTestId('auto-resume-m1');
    expect(marker).toHaveAttribute('role', 'separator');
    expect(marker).toHaveTextContent('thread.autoResumed');
    expect(marker).not.toHaveTextContent('continue');
  });

  test('omits the time when the timestamp is missing or invalid', () => {
    render(
      <TooltipProvider>
        <AutoResumeMarker data-testid="auto-resume-m2" timestamp="not-a-date" />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('auto-resume-m2').textContent).not.toContain('·');
  });
});
