import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { MermaidBlock, MermaidExpandedDialog } from './MermaidBlock';

const chart = 'flowchart LR\nA[Client] --> B[Server]';

function Diagram({ source = chart }: { source?: string }) {
  return (
    <TooltipProvider>
      <MermaidBlock chart={source} />
    </TooltipProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('MermaidBlock', () => {
  it('fits the synchronous first render and preserves zoom/reset controls', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(420);
    render(<Diagram />);
    const svg = screen.getByTestId('mermaid-diagram').querySelector('svg')!;
    expect(svg.textContent).toContain('Client');
    const wrapper = svg.parentElement!;
    const fitted = wrapper.style.transform;
    expect(fitted).not.toContain('scale(1)');
    fireEvent.click(screen.getByTestId('mermaid-inline-zoom-in'));
    expect(wrapper.style.transform).not.toBe(fitted);
    fireEvent.click(screen.getByTestId('mermaid-inline-zoom-reset'));
    expect(wrapper.style.transform).toBe(fitted);
    fireEvent.click(screen.getByTestId('mermaid-inline-expand'));
    expect(screen.getByRole('dialog').querySelector('svg text')).not.toBeNull();
    expect(screen.getByTestId('mermaid-copy-code')).toBeInTheDocument();
    expect(screen.getByTestId('mermaid-copy-image')).toBeInTheDocument();
  });

  it('recovers when an unsupported source is replaced with a supported diagram', () => {
    const { rerender } = render(<Diagram source={'pie\n"Dogs" : 10'} />);
    expect(screen.getByTestId('mermaid-error')).toHaveTextContent('unsupported');
    rerender(<Diagram />);
    expect(screen.queryByTestId('mermaid-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('mermaid-diagram').querySelector('svg')).not.toBeNull();
  });

  it('shows rendering errors in a standalone expanded dialog', () => {
    render(
      <TooltipProvider>
        <MermaidExpandedDialog chart="unsupported" open onClose={() => {}} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid or unsupported diagram');
  });
});
