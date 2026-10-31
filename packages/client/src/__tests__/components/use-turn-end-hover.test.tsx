import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, test } from 'vitest';

import { useTurnEndHover } from '@/components/thread/use-turn-end-hover';

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useTurnEndHover(ref);
  return (
    <div ref={ref}>
      <div data-turn-section="u1">
        <p>First answer</p>
        <div data-testid="bar-u1" data-turn-end-for="u1" />
      </div>
      <div data-turn-section="u2">
        <p>Second answer</p>
        <div data-testid="bar-u2" data-turn-end-for="u2" />
      </div>
    </div>
  );
}

describe('useTurnEndHover', () => {
  test('reveals only the bar of the hovered turn and hides it on leave', () => {
    const { container } = render(<Harness />);

    fireEvent.mouseOver(screen.getByText('First answer'));
    expect(screen.getByTestId('bar-u1')).toHaveAttribute('data-hovered');
    expect(screen.getByTestId('bar-u2')).not.toHaveAttribute('data-hovered');

    fireEvent.mouseOver(screen.getByText('Second answer'));
    expect(screen.getByTestId('bar-u1')).not.toHaveAttribute('data-hovered');
    expect(screen.getByTestId('bar-u2')).toHaveAttribute('data-hovered');

    fireEvent.mouseLeave(container.firstElementChild as HTMLElement);
    expect(screen.getByTestId('bar-u2')).not.toHaveAttribute('data-hovered');
  });
});
