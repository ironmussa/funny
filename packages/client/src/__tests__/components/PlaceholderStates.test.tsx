import { render, screen, fireEvent } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { describe, expect, test, vi } from 'vitest';

import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';

describe('placeholder consistency', () => {
  test.each(['stack', 'inline'] as const)(
    'keeps the same scale in %s loading and empty states',
    (layout) => {
      render(
        <>
          <LoadingState layout={layout} label="Loading files" testId="loading" />
          <EmptyState
            icon={Inbox}
            title="No files"
            description="Add your first file"
            testId="empty"
          />
        </>,
      );
      for (const id of ['loading', 'empty']) {
        expect(screen.getByTestId(id).querySelector('svg')).toHaveClass('size-6', 'shrink-0');
      }
      for (const text of ['Loading files', 'No files', 'Add your first file']) {
        expect(screen.getByText(text)).toHaveClass('text-sm', 'font-normal');
      }
    },
  );

  test('content-sized placeholders keep actions usable without forcing full height', () => {
    const onClick = vi.fn();
    render(
      <>
        <LoadingState fill={false} testId="loading" />
        <EmptyState
          fill={false}
          title="No files"
          testId="empty"
          action={<button onClick={onClick}>Add file</button>}
        />
      </>,
    );
    expect(screen.getByTestId('loading')).not.toHaveClass('h-full');
    expect(screen.getByTestId('empty')).not.toHaveClass('h-full');
    expect(screen.getByTestId('loading').querySelector('p')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
