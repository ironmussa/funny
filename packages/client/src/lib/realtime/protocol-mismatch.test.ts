import { afterEach, describe, expect, test, vi, mock } from 'bun:test';

const warning = (() => vi.fn())();
mock.module('sonner', () => ({ toast: { warning } }));

import { notifyIncompatibleProtocol, resetProtocolMismatchNotice } from './protocol-mismatch';

afterEach(() => {
  warning.mockClear();
  resetProtocolMismatchNotice();
});

describe('notifyIncompatibleProtocol', () => {
  test('tells the user once, with a Reload action', () => {
    const reload = vi.fn();
    notifyIncompatibleProtocol('Generated browser schema identity is incompatible', reload);
    notifyIncompatibleProtocol('again', reload);

    expect(warning).toHaveBeenCalledTimes(1);
    const options = warning.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
    expect(options.action.label).toBe('Reload');
    options.action.onClick();
    expect(reload).toHaveBeenCalled();
  });
});
