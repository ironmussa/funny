import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const markdown = vi.hoisted(() => ({
  renderMarkdownToSafeHtml: vi.fn(),
}));

vi.mock('@/lib/satteri-markdown', () => markdown);

import { SatteriMessageContent } from '@/components/thread/SatteriMessageContent';

describe('SatteriMessageContent', () => {
  beforeEach(() => {
    markdown.renderMarkdownToSafeHtml.mockReset();
  });

  test('preserves the source text instead of switching markdown engines after a compiler failure', async () => {
    markdown.renderMarkdownToSafeHtml.mockRejectedValueOnce(new Error('WASM unavailable'));

    render(<SatteriMessageContent content="## Keep this message" />);

    const error = await screen.findByRole('alert');
    expect(error).toHaveAttribute('data-satteri-error', 'compile');
    expect(error).toHaveTextContent('## Keep this message');
    expect(screen.queryByTestId('satteri-markdown')).not.toBeInTheDocument();
  });
});
