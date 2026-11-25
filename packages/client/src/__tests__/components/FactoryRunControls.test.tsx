import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryRun } from '@/lib/api/factory';

const mocks = ((): { control: Mock<(...args: any[]) => any> } => ({ control: vi.fn() }))();

mock.module('@/data/projects/hooks', () => ({ useCanSteerProject: () => true }));
mock.module('@/data/factory/actions', () => ({
  controlFactoryRun: (...args: unknown[]) => mocks.control(...args),
}));
mock.module('@/lib/toast-error', () => ({ toastError: vi.fn() }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _k: string,
      fallback?: string | Record<string, unknown>,
      vars?: Record<string, unknown>,
    ) => {
      const values = typeof fallback === 'string' ? vars : fallback;
      const text = typeof fallback === 'string' ? fallback : String(values?.defaultValue ?? _k);
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(values?.[name] ?? ''));
    },
  }),
}));

import { FactoryRunControls } from '@/components/thread/FactoryRunControls';

const PARTS = ['Clear the client warnings', 'Clear the server warnings'];

/** A run parked because triage found issue #464 too large, with the parts it proposed. */
const tooBig = (over: Partial<FactoryRun> = {}): FactoryRun =>
  buildFactoryRun({
    id: 'r1',
    issueNumber: 464,
    state: 'needs_info',
    failureReason: 'needs info',
    triage: { decision: 'too_big', at: '2026-11-24T08:45:27Z', threadId: 'tr', items: PARTS },
    ...over,
  });

const renderControls = (run: FactoryRun) =>
  render(<FactoryRunControls projectId="p1" run={run} testId={(button) => `controls-${button}`} />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.control.mockImplementation(() => okAsync(tooBig({ state: 'done' })));
});

describe('FactoryRunControls: splitting a run parked as too large', () => {
  test('offers the split, shows the parts, and splits only once confirmed', async () => {
    renderControls(tooBig());

    fireEvent.click(screen.getByTestId('controls-split'));
    expect(mocks.control).not.toHaveBeenCalled();
    expect(await screen.findByText('Split issue #464?')).toBeInTheDocument();
    const parts = within(screen.getByTestId('factory-split-parts')).getAllByRole('listitem');
    expect(parts.map((item) => item.textContent)).toEqual(PARTS);

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(mocks.control).toHaveBeenCalledWith('split', 'p1', 'r1');
  });

  test('the split button names how many issues it opens; Retry stays offered', () => {
    renderControls(tooBig());
    expect(screen.getByTestId('controls-split')).toHaveTextContent('Split into 2 issues');
    expect(screen.getByTestId('controls-retry')).toBeInTheDocument();
  });

  test('a run parked to ask questions, or with no proposed parts, offers no split', () => {
    const { rerender } = renderControls(
      tooBig({
        triage: {
          decision: 'needs_info',
          at: '2026-11-24T08:45:27Z',
          threadId: 'tr',
          items: ['?'],
        },
      }),
    );
    expect(screen.queryByTestId('controls-split')).toBeNull();

    rerender(
      <FactoryRunControls
        projectId="p1"
        run={tooBig({ triage: { decision: 'too_big', at: '2026-11-24T08:45:27Z', items: [] } })}
        testId={(button) => `controls-${button}`}
      />,
    );
    expect(screen.queryByTestId('controls-split')).toBeNull();
  });

  test('a run already split (done) offers no split', () => {
    renderControls(tooBig({ state: 'done' }));
    expect(screen.queryByTestId('controls-split')).toBeNull();
  });
});
