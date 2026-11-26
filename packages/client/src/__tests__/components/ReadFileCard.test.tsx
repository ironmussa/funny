import { describe, expect, test } from 'bun:test';

import { fireEvent, screen } from '@testing-library/react';

import { ReadFileCard } from '@/components/tool-cards/ReadFileCard';

import { renderWithProviders } from '../helpers/render';

const OUTPUT = '   1→const answer = 42;\n   2→export default answer;';

describe('ReadFileCard', () => {
  // Cursor ACP reads can arrive with no path (upstream metadata bug, issue #9).
  test.each([
    ['absent', {}],
    ['empty', { file_path: '' }],
  ])('shows a degraded card when file_path is %s', (_case, parsed) => {
    renderWithProviders(<ReadFileCard parsed={parsed} output={OUTPUT} />);

    expect(screen.getByTestId('read-file-path-unavailable')).toHaveTextContent('path unavailable');
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('read-file-open-link')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Read File').closest('button')!);

    expect(screen.getAllByText('path unavailable')).toHaveLength(2);
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('read-file-open-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('read-file-toggle-markdown')).not.toBeInTheDocument();
    expect(screen.getByTestId('read-file-copy')).toBeInTheDocument();
    expect(screen.getByText('const answer = 42;')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  test('keeps the open link, file name and extension badge when file_path is present', () => {
    renderWithProviders(
      <ReadFileCard parsed={{ file_path: '/repo/src/answer.ts' }} output={OUTPUT} />,
    );

    expect(screen.getByTestId('read-file-open-link')).toBeInTheDocument();
    expect(screen.queryByTestId('read-file-path-unavailable')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Read File').closest('button')!);

    expect(screen.getByText('answer.ts')).toBeInTheDocument();
    expect(screen.getByText('ts')).toBeInTheDocument();
    expect(screen.queryByText('path unavailable')).not.toBeInTheDocument();
  });
});
