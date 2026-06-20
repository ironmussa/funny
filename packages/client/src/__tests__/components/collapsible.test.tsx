import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

describe('Collapsible', () => {
  test('toggles uncontrolled content without measuring layout', () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>Panel</CollapsibleContent>
      </Collapsible>,
    );

    const trigger = screen.getByRole('button', { name: 'Toggle' });

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Panel')).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Panel')).not.toBeInTheDocument();
  });

  test('supports controlled state with asChild triggers', () => {
    function ControlledCollapsible() {
      const [open, setOpen] = useState(false);

      return (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button data-testid="custom-trigger">Custom Toggle</button>
          </CollapsibleTrigger>
          <CollapsibleContent data-testid="content">Controlled Panel</CollapsibleContent>
        </Collapsible>
      );
    }

    render(<ControlledCollapsible />);

    const trigger = screen.getByTestId('custom-trigger');

    expect(trigger).toHaveAttribute('data-state', 'closed');
    expect(screen.queryByTestId('content')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('content')).toHaveAttribute('data-state', 'open');
  });
});
