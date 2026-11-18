import { describe, expect, test, vi } from 'vitest';

const toastErrorMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastErrorMock(...args) } }));

import { toastError } from '@/lib/toast-error';

// Real i18n: the factory's refusals (paused, no GitHub App, repository
// unreadable) are written for the user, so the toast shows them instead of the
// generic "A conflict occurred" text.
describe('toastError in the factory context', () => {
  test.each(['CONFLICT', 'BAD_REQUEST', 'NOT_FOUND'] as const)(
    'shows the server message for %s',
    (type) => {
      toastError({ type, message: 'The issue factory is paused.' }, 'factory');
      expect(toastErrorMock).toHaveBeenLastCalledWith('The issue factory is paused.', undefined);
    },
  );

  test('without the context a conflict stays generic', () => {
    toastError({ type: 'CONFLICT', message: 'The issue factory is paused.' });
    expect(toastErrorMock).toHaveBeenLastCalledWith(
      'A conflict occurred. The resource may have been modified.',
      undefined,
    );
  });
});
