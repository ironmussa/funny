import { describe, expect, mock, test } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';

import { isFromInsideRow } from '@/components/commit-graph/GraphCommitRow';

/**
 * A confirm dialog opened from a commit row's menu is portaled to <body>, but
 * React still bubbles its clicks to the row. Confirming "Discard stash" used to
 * select the row and open the commit details too.
 */
function Row({ onSelect }: { onSelect: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="row"
      onClick={(e) => {
        if (isFromInsideRow(e)) onSelect();
      }}
    >
      <span data-testid="row-title">commit</span>
      {createPortal(<button data-testid="dialog-confirm">Discard stash</button>, document.body)}
    </div>
  );
}

describe('commit graph row selection', () => {
  test('a click inside the row selects it', () => {
    const onSelect = mock(() => {});
    render(<Row onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('row-title'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test('a click in a portaled dialog does not select the row', () => {
    const onSelect = mock(() => {});
    render(<Row onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('dialog-confirm'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
