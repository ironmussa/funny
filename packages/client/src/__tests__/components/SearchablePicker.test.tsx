import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { SearchablePicker } from '@/components/SearchablePicker';

const virtualizer = vi.hoisted(() => ({
  measure: vi.fn(),
  scrollToIndex: vi.fn(),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    ...virtualizer,
    getTotalSize: () => 0,
    getVirtualItems: () => [],
  }),
}));

describe('SearchablePicker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('measures and scrolls the selected item when opened, then selects from the keyboard', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const onSelect = vi.fn();

    render(
      <SearchablePicker
        items={[
          { key: 'main', label: 'main', isSelected: true },
          { key: 'develop', label: 'develop', isSelected: false },
        ]}
        label="Branch"
        displayValue="main"
        searchPlaceholder="Search branches"
        noMatchText="No branches match"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /main/i }));

    const input = await screen.findByRole('textbox', { name: 'Branch' });
    await waitFor(() => expect(input).toHaveFocus());
    act(() => {
      frames.splice(0).forEach((callback) => callback(0));
    });

    expect(virtualizer.measure).toHaveBeenCalledOnce();
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'center' });

    fireEvent.change(input, { target: { value: 'develop' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('develop');
  });
});
