import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ReadFileCard } from '@/components/tool-cards/ReadFileCard';
import { WriteFileCard } from '@/components/tool-cards/WriteFileCard';

import { renderWithProviders } from '../helpers/render';

vi.mock('@/components/thread/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => (
    <article data-testid="rendered-markdown">{content}</article>
  ),
}));

describe('Markdown tool card previews', () => {
  test('Write defaults to preview and toggles to source for .markdown files', () => {
    renderWithProviders(
      <WriteFileCard parsed={{ file_path: 'docs/guide.markdown', content: '# Guide' }} />,
    );

    const toggle = screen.getByTestId('write-file-toggle-markdown');
    expect(toggle).toHaveAttribute('aria-label', 'View source');
    expect(screen.getByTestId('rendered-markdown')).toHaveTextContent('# Guide');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-label', 'Preview');
    expect(screen.queryByTestId('rendered-markdown')).not.toBeInTheDocument();
    expect(screen.getByText('# Guide')).toBeInTheDocument();
  });

  test('Read defaults to preview and strips tool line prefixes', () => {
    renderWithProviders(
      <ReadFileCard parsed={{ file_path: 'docs/guide.mdx' }} output={'   1→# Guide\n   2→Body'} />,
    );

    fireEvent.click(screen.getByText('Read File').closest('button')!);

    const toggle = screen.getByTestId('read-file-toggle-markdown');
    expect(toggle).toHaveAttribute('aria-label', 'View source');
    expect(screen.getByTestId('rendered-markdown')).toHaveTextContent('# Guide Body');
  });
});
