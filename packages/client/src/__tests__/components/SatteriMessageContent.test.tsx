import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const markdown = vi.hoisted(() => ({
  renderMarkdownToSafeHtml: vi.fn(),
  renderReadyMarkdownToSafeHtml: vi.fn(),
}));

vi.mock('@/lib/satteri-markdown', () => markdown);

import { SatteriMessageContent } from '@/components/thread/SatteriMessageContent';

describe('SatteriMessageContent', () => {
  beforeEach(() => {
    markdown.renderMarkdownToSafeHtml.mockReset();
    markdown.renderReadyMarkdownToSafeHtml.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  test('renders available markdown on the first commit without reverting to plain text', () => {
    markdown.renderReadyMarkdownToSafeHtml.mockReturnValue('<h2>Ready</h2>');

    const { container, rerender } = render(<SatteriMessageContent content="## Ready" />);

    expect(screen.getByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    expect(container.querySelector('[data-satteri-pending]')).toBeNull();
    expect(markdown.renderMarkdownToSafeHtml).not.toHaveBeenCalled();

    markdown.renderReadyMarkdownToSafeHtml.mockReturnValue('<h2>Updated</h2>');
    rerender(<SatteriMessageContent content="## Updated" />);
    expect(screen.getByRole('heading', { name: 'Updated' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ready' })).toBeNull();
    expect(container.querySelector('[data-satteri-pending]')).toBeNull();
  });

  test('preserves the source text instead of switching markdown engines after a compiler failure', async () => {
    markdown.renderMarkdownToSafeHtml.mockRejectedValueOnce(new Error('WASM unavailable'));

    render(<SatteriMessageContent content="## Keep this message" />);

    const error = await screen.findByRole('alert');
    expect(error).toHaveAttribute('data-satteri-error', 'compile');
    expect(error).toHaveTextContent('## Keep this message');
    expect(screen.queryByTestId('satteri-markdown')).not.toBeInTheDocument();
  });

  test("sets a code block's layout classes before asynchronous syntax highlighting", async () => {
    markdown.renderMarkdownToSafeHtml.mockResolvedValueOnce(
      '<pre><code class="language-ts">const value = 1;</code></pre>',
    );

    render(<SatteriMessageContent content={'```ts\nconst value = 1;\n```'} />);

    const root = await screen.findByTestId('satteri-markdown');
    const code = root.querySelector('pre > code');
    expect(code).toHaveClass('hljs', 'block', 'overflow-x-auto', 'font-mono', 'text-sm');
  });

  test('uses icons for code-block copy feedback', async () => {
    markdown.renderMarkdownToSafeHtml.mockResolvedValueOnce(
      '<pre><code class="language-ts">const value = 1;</code></pre>',
    );

    render(<SatteriMessageContent content={'```ts\nconst value = 1;\n```'} />);

    const copyButton = await screen.findByRole('button', { name: 'Copy code' });
    expect(copyButton.querySelector('[data-satteri-copy-icon="copy"]')).toBeInTheDocument();
    expect(copyButton).not.toHaveTextContent('Copy');

    fireEvent.click(copyButton);

    await waitFor(() => expect(copyButton).toHaveAccessibleName('Copied'));
    expect(copyButton.querySelector('[data-satteri-copy-icon="check"]')).toHaveClass(
      'text-green-600',
    );
    expect(copyButton.querySelector('[data-satteri-copy-icon="check"]')).toBeInTheDocument();
    await waitFor(() => expect(copyButton).toHaveAccessibleName('Copy code'), { timeout: 3000 });
    expect(copyButton.querySelector('[data-satteri-copy-icon="copy"]')).toBeInTheDocument();
  });

  test('uses the final markdown text styling while the compiler is loading', () => {
    markdown.renderMarkdownToSafeHtml.mockImplementationOnce(() => new Promise(() => {}));

    const { container } = render(
      <SatteriMessageContent content="A message that is still compiling" />,
    );

    const pending = container.querySelector('[data-satteri-pending]');
    expect(pending).toBeInTheDocument();
    expect(pending).toHaveClass('prose', 'max-w-none', 'text-foreground', 'whitespace-pre-wrap');
    expect(pending).not.toHaveClass('text-muted-foreground');
  });
});
