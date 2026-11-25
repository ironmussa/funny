import { afterEach, describe, expect, it, vi, setDefaultTimeout } from 'bun:test';

import { stubGlobal, unstubAllGlobals } from '@funny/test-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';

import { MermaidBlock, MermaidExpandedDialog } from './MermaidBlock';

// The proof and pre-push run these files together under `bun test --parallel`; on a
// loaded machine a first render (cold module load) ran well past the 5 s default.
setDefaultTimeout(60_000);

const chart = 'flowchart LR\nA[Client] --> B[Server]';

function Diagram({ source = chart }: { source?: string }) {
  return (
    <TooltipProvider>
      <MermaidBlock chart={source} />
    </TooltipProvider>
  );
}

const elementSizeProps = ['clientWidth', 'clientHeight'] as const;
const originalSizeDescriptors = elementSizeProps.map(
  (prop) => [prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)] as const,
);

/** Bun's spyOn cannot spy on getters: define the size getters directly. */
function stubElementSize(width: number, height: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    get: () => width,
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    get: () => height,
    configurable: true,
  });
}

afterEach(() => {
  for (const [prop, descriptor] of originalSizeDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, prop);
  }
  vi.restoreAllMocks();
  unstubAllGlobals();
});

describe('MermaidBlock', () => {
  it('fits the synchronous first render and preserves zoom/reset controls', () => {
    stubElementSize(800, 420);
    render(<Diagram />);
    const svg = screen.getByTestId('mermaid-diagram').querySelector('svg')!;
    expect(svg.textContent).toContain('Client');
    const wrapper = svg.parentElement!;
    expect(wrapper).toHaveClass('[transform:var(--mermaid-transform)]');
    const fitted = wrapper.style.getPropertyValue('--mermaid-transform');
    expect(fitted).not.toContain('scale(1)');
    fireEvent.click(screen.getByTestId('mermaid-inline-zoom-in'));
    expect(wrapper.style.getPropertyValue('--mermaid-transform')).not.toBe(fitted);
    fireEvent.click(screen.getByTestId('mermaid-inline-zoom-reset'));
    expect(wrapper.style.getPropertyValue('--mermaid-transform')).toBe(fitted);
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

  it('downloads the diagram as a standalone SVG file', async () => {
    let downloaded: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloaded = blob;
      return 'blob:mermaid';
    });
    const revokeObjectURL = vi.fn();
    stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    // Bun's mocks do not record `mock.instances`: capture the clicked anchor.
    const clickedAnchors: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedAnchors.push(this);
    });
    render(
      <TooltipProvider>
        <MermaidExpandedDialog chart={chart} open onClose={() => {}} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('mermaid-download-svg'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const anchor = clickedAnchors[0];
    expect(anchor.download).toBe('mermaid-diagram.svg');
    expect(downloaded?.type).toBe('image/svg+xml;charset=utf-8');
    const text = await downloaded!.text();
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(text).toContain('Client');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mermaid');
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
