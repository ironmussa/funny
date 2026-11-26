/**
 * Every toast has the same bound on its text: a long message (a git hook's
 * whole output on a failed push) is cut at a few lines and long words wrap,
 * instead of the toast filling the screen.
 */
import { describe, expect, test } from 'bun:test';

import { act, render, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

import { Toaster } from '@/components/ui/sonner';

describe('Toaster', () => {
  test("a long toast's title and description are clamped and wrap", async () => {
    const { container } = render(<Toaster />);
    const long = 'src/__tests__/data/background.test.tsx: (pass) loading '.repeat(80);
    act(() => {
      toast.error(long, { description: long });
    });
    await waitFor(() => expect(container.querySelector('[data-title]')).not.toBeNull());
    for (const part of ['[data-title]', '[data-description]']) {
      const element = container.querySelector(part)!;
      expect(element.className).toContain('line-clamp-4');
      expect(element.className).toContain('break-words');
    }
  });
});
