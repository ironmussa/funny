/**
 * Every toast has the same bound on its text: a long message (a git hook's
 * whole output on a failed push) is cut at a few lines and long words wrap,
 * instead of the toast filling the screen.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

import { toast, Toaster } from '@/components/ui/toast';

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
});

describe('Toaster', () => {
  test("a long toast's title and description are clamped and wrap", async () => {
    const { baseElement } = render(<Toaster />);
    const long = 'src/__tests__/data/background.test.tsx: (pass) loading '.repeat(80);
    act(() => {
      toast.error(long, { description: long });
    });
    await waitFor(() => expect(baseElement.querySelector('[data-title]')).not.toBeNull());
    for (const part of ['[data-title]', '[data-description]']) {
      const element = baseElement.querySelector(part)!;
      expect(element.className).toContain('line-clamp-4');
      expect(element.className).toContain('break-words');
    }
  });

  test('renders an inline close button that dismisses the toast', async () => {
    const { baseElement } = render(<Toaster />);
    act(() => {
      toast.success('Saved changes');
    });
    await waitFor(() => expect(baseElement.querySelector('[data-slot="toast"]')).not.toBeNull());
    const closeBtn = baseElement.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    await waitFor(() => expect(baseElement.querySelector('[data-slot="toast"]')).toBeNull());
  });
});
