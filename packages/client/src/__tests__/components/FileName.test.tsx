import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FileName } from '@/components/ui/file-name';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderName(props: Parameters<typeof FileName>[0]) {
  const { container } = render(
    <TooltipProvider delayDuration={0}>
      <FileName {...props} />
    </TooltipProvider>,
  );
  return container.firstElementChild as HTMLElement;
}

describe('FileName', () => {
  it('shows the full name in a shadcn tooltip without a native tooltip', async () => {
    const name = 'a'.repeat(80) + '.json';
    const label = renderName({ name });
    expect(label).not.toHaveAttribute('title');
    fireEvent.pointerMove(label, { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
    expect(document.querySelector('[data-slot="tooltip-content"]')).toHaveTextContent(name);
  });

  it.each(['a'.repeat(80) + '.json', 'recording.wav', 'archive.tar.gz', '.env.local'])(
    'reserves space for the extension of %s',
    (name) => {
      const label = renderName({ name });
      expect(label).toHaveTextContent(name);
      expect(label.firstElementChild).toHaveClass('truncate');
      expect(label.lastElementChild).toHaveTextContent(name.slice(name.lastIndexOf('.')));
      expect(label.lastElementChild).toHaveClass('shrink-0', 'whitespace-nowrap');
      expect(label.lastElementChild).not.toHaveClass('truncate');
    },
  );

  it.each(['README', '.gitignore', 'filename.'])('keeps %s as a single name', (name) => {
    const label = renderName({ name });
    expect(label.children).toHaveLength(1);
    expect(label).toHaveTextContent(name);
  });

  it('preserves search highlights across the extension boundary', () => {
    const label = renderName({ name: 'example.tsx', query: 'le.ts' });
    const marks = label.querySelectorAll('mark');
    expect(Array.from(marks, (mark) => mark.textContent)).toEqual(['le', '.ts']);
  });

  it('does not treat dotted submodule names as file extensions', () => {
    const label = renderName({ name: 'module.repo', preserveExtension: false });
    expect(label.children).toHaveLength(1);
  });
});
