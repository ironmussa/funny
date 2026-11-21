import { describe, expect, test } from 'bun:test';

import { render, screen } from '@testing-library/react';

import { AgentAccountSummary } from '@/components/thread/AgentAccountSummary';
import type { AgentAccountRow } from '@/data/agent-account/store';

const inTwoHours = () => new Date(Date.now() + 2 * 60 * 60_000 + 30_000).toISOString();

function account(overrides: Partial<AgentAccountRow> = {}): AgentAccountRow {
  return {
    id: 'acc-1',
    profileId: 'p1',
    profileName: 'Work',
    account: { email: 'dev@example.com', organization: 'Acme', subscriptionType: 'max' },
    capturedAt: Date.now(),
    ...overrides,
  };
}

describe('AgentAccountSummary', () => {
  test('shows the profile, plan and identity, and each usage window with its reset', () => {
    render(
      <AgentAccountSummary
        account={account({
          usage: {
            windows: [{ key: 'five_hour', utilization: 42.4, resetsAt: inTwoHours() }],
            extraUsage: { usedCredits: 3, monthlyLimit: 50, utilization: 6, currency: 'USD' },
          },
        })}
      />,
    );

    expect(screen.getByTestId('agent-account-profile').textContent).toBe('Work');
    expect(screen.getByTestId('agent-account-plan').textContent).toBe('Max');
    expect(screen.getByTestId('agent-account-identity').textContent).toBe('dev@example.com · Acme');
    const row = screen.getByTestId('agent-account-window-five_hour');
    expect(row.textContent).toContain('Current session (5h)');
    expect(row.textContent).toContain('42%');
    expect(row.textContent).toContain('resets in 2h');
    expect(screen.getByTestId('agent-account-extra').textContent).toBe('Extra usage: 3 / 50 USD');
    expect(screen.getByText('Updated just now')).toBeTruthy();
  });

  test('a window without a reading shows a dash, and no extra usage line without credits', () => {
    render(
      <AgentAccountSummary
        account={account({
          usage: {
            windows: [{ key: 'seven_day', utilization: null, resetsAt: null }],
            extraUsage: { usedCredits: null, monthlyLimit: null, utilization: null },
          },
        })}
      />,
    );

    expect(screen.getByTestId('agent-account-window-seven_day').textContent).toContain('—');
    expect(screen.queryByTestId('agent-account-extra')).toBeNull();
  });

  test('a third-party provider says plan limits do not apply', () => {
    render(<AgentAccountSummary account={account({ account: { apiProvider: 'bedrock' } })} />);

    expect(screen.getByText('Plan limits do not apply (bedrock).')).toBeTruthy();
    expect(screen.queryByTestId('agent-account-usage')).toBeNull();
  });

  test('before any report: the recorded profile name, no usage, no provider note', () => {
    render(<AgentAccountSummary profileName="Personal" />);

    expect(screen.getByTestId('agent-account-profile').textContent).toBe('Personal');
    expect(screen.queryByTestId('agent-account-plan')).toBeNull();
    expect(screen.queryByTestId('agent-account-usage')).toBeNull();
    expect(screen.queryByText(/Plan limits do not apply/)).toBeNull();
  });
});
