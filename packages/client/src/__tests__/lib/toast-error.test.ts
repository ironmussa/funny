import type { DomainError } from '@funny/shared/errors';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { toastErrorMock, logWarnMock, tMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  logWarnMock: vi.fn(),
  tMock: vi.fn((key: string, opts?: { defaultValue?: string; message?: string }) => {
    if (opts?.defaultValue === '') return '';
    return opts?.defaultValue ?? key;
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

vi.mock('@/lib/client-logger', () => ({
  createClientLogger: () => ({ warn: logWarnMock }),
}));

vi.mock('@/i18n/config', () => ({
  default: {
    t: (...args: unknown[]) =>
      tMock(...(args as [string, { defaultValue?: string; message?: string }])),
  },
}));

import { toastError } from '@/lib/toast-error';

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
