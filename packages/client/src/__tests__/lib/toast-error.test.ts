import { describe, test, expect, vi, beforeEach, mock } from 'bun:test';

import type { DomainError } from '@funny/shared/errors';

const { toastErrorMock, logWarnMock, tMock } = (() => ({
  toastErrorMock: vi.fn(),
  logWarnMock: vi.fn(),
  tMock: vi.fn((key: string, opts?: { defaultValue?: string; message?: string }) => {
    if (opts?.defaultValue === '') return '';
    return opts?.defaultValue ?? key;
  }),
}))();

mock.module('@/components/ui/toast', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

mock.module('@/lib/client-logger', () => ({
  isClientLogLevelEnabled: () => false,
  createClientLogger: () => ({ warn: logWarnMock }),
}));

mock.module('@/i18n/config', () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: string; message?: string }) => tMock(key, opts),
  },
}));

// Imported after the mocks: the module creates its logger at import time.
const { toastError } = await import('@/lib/toast-error');

describe('toastError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('shows server-provided friendlyMessage', () => {
    const error: DomainError = {
      type: 'INTERNAL',
      message: 'raw',
      friendlyMessage: 'Something broke',
    };

    toastError(error);

    expect(toastErrorMock).toHaveBeenCalledWith('Something broke', undefined);
    expect(logWarnMock).toHaveBeenCalled();
  });

  test('uses context-specific i18n key when available', () => {
    tMock.mockImplementation((key: string, opts?: { defaultValue?: string }) => {
      if (key === 'errors.transcribeToken.INTERNAL') return 'Transcription failed';
      return opts?.defaultValue ?? key;
    });

    toastError({ type: 'INTERNAL', message: 'boom' }, 'transcribeToken');

    expect(toastErrorMock).toHaveBeenCalledWith('Transcription failed', undefined);
  });

  test('falls back to generic unknown message', () => {
    tMock.mockImplementation(
      (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? '',
    );

    toastError({ type: 'INTERNAL', message: 'boom' });

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Something went wrong. Please try again.',
      undefined,
    );
  });
});
